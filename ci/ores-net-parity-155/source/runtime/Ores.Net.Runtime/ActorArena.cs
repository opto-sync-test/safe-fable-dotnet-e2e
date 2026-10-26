using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;

namespace Ores.Net.Runtime;

/// <summary>
/// Opaque actor-private persistent allocation capability. The offset and arena
/// authority are intentionally not public and a default value is invalid.
/// </summary>
public readonly struct ActorArenaHandle
{
    private readonly Guid _authority;
    private readonly int _slot;
    private readonly ulong _generation;
    private readonly ulong _actorId;
    private readonly ulong _incarnation;

    public int Length { get; }

    internal ActorArenaHandle(Guid authority, int slot, ulong generation,
        ulong actorId, ulong incarnation, int length)
    {
        _authority = authority;
        _slot = slot;
        _generation = generation;
        _actorId = actorId;
        _incarnation = incarnation;
        Length = length;
    }

    internal Guid Authority => _authority;
    internal int Slot => _slot;
    internal ulong Generation => _generation;
    internal ulong ActorId => _actorId;
    internal ulong Incarnation => _incarnation;
}

/// <summary>
/// Turn-scoped scratch allocation. Scratch capabilities are invalidated when
/// the physical actor turn exits, regardless of whether the next carrier is
/// the same operating-system thread.
/// </summary>
public readonly struct ActorScratchHandle
{
    private readonly Guid _authority;
    private readonly ulong _epoch;
    private readonly int _offset;

    public int Length { get; }

    internal ActorScratchHandle(Guid authority, ulong epoch, int offset, int length)
    {
        _authority = authority;
        _epoch = epoch;
        _offset = offset;
        Length = length;
    }

    internal Guid Authority => _authority;
    internal ulong Epoch => _epoch;
    internal int Offset => _offset;
}

/// <summary>
/// One admitted physical actor turn. There may be at most one active turn for
/// an ActorArena. Dispose is the mandatory scratch-reset and quiescence edge.
/// </summary>
public sealed class ActorArenaTurn : IDisposable
{
    private int _released;

    internal ActorArenaTurn(ActorArena arena, Guid authority, ulong actorId,
        ulong incarnation, ulong epoch)
    {
        Arena = arena;
        Authority = authority;
        ActorId = actorId;
        Incarnation = incarnation;
        Epoch = epoch;
    }

    internal ActorArena Arena { get; }
    internal Guid Authority { get; }
    internal ulong ActorId { get; }
    internal ulong Incarnation { get; }
    internal ulong Epoch { get; }
    internal bool Released => Volatile.Read(ref _released) != 0;

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _released, 1) == 0)
            Arena.ReleaseTurn(this);
    }
}

/// <summary>
/// Read-only lifetime loan for one persistent allocation. The loan may survive
/// a turn/suspension, but it grants no out-of-turn dereference API. While live,
/// mutation and drop of the allocation are denied and arena reclamation waits.
/// </summary>
public sealed class ActorArenaReadLoan : IDisposable
{
    private ActorArena? _arena;
    private int _released;

    internal ActorArenaReadLoan(ActorArena arena, Guid authority, int slot,
        ulong generation, ulong actorId, ulong incarnation, int length)
    {
        _arena = arena;
        Authority = authority;
        Slot = slot;
        Generation = generation;
        ActorId = actorId;
        Incarnation = incarnation;
        Length = length;
    }

    internal Guid Authority { get; }
    internal int Slot { get; }
    internal ulong Generation { get; }
    internal ulong ActorId { get; }
    internal ulong Incarnation { get; }
    public int Length { get; }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _released, 1) != 0)
            return;
        var arena = Interlocked.Exchange(ref _arena, null);
        arena?.ReleaseReadLoan(this);
    }
}

/// <summary>
/// Lifetime-only pin for an async continuation, FFI operation, or I/O callback.
/// It deliberately exposes no byte/handle access. Release may happen on a
/// different carrier and is idempotent.
/// </summary>
public sealed class ActorArenaLifetimePin : IDisposable
{
    private ActorArena? _arena;
    private int _released;

    internal ActorArenaLifetimePin(ActorArena arena, Guid authority)
    {
        _arena = arena;
        Authority = authority;
    }

    internal Guid Authority { get; }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _released, 1) != 0)
            return;
        var arena = Interlocked.Exchange(ref _arena, null);
        arena?.ReleaseLifetimePin(Authority);
    }
}

/// <summary>
/// Bounded actor-owned unmanaged storage for .NET Native AOT.
///
/// Persistent bytes survive actor turns. Scratch bytes are bulk-zeroed on every
/// turn exit. Persistent slots are generation-fenced and partial frees never
/// move live values. The byte bump pointer is recycled only after the last live
/// persistent allocation is dropped, matching the native backend's simple,
/// predictable non-compacting heap substrate.
///
/// This is a host-runtime substrate, not yet general Oreslang guest-object
/// lowering and not a security sandbox. Managed control metadata remains on the
/// CLR heap; actor payload bytes live in NativeMemory allocations.
/// </summary>
public unsafe sealed class ActorArena : IDisposable
{
    public const int MaxArenaBytes = 64 * 1024 * 1024;
    public const int MaxAllocationSlots = 65_536;
    public const int MaxOutstandingLifetimePins = 65_536;
    public const int MaxOutstandingReadLoans = 65_536;

    private const int SlabAlignment = 64;

    private struct Slot
    {
        internal int Offset;
        internal int Length;
        internal ulong Generation;
        internal int ReadLoans;
        internal bool Live;
    }

    private readonly object _gate = new();
    private readonly ulong _actorId;
    private readonly ulong _incarnation;
    private readonly Guid _authority;
    private readonly int _persistentCapacity;
    private readonly int _scratchCapacity;
    private readonly int _persistentPhysicalBytes;
    private readonly int _scratchPhysicalBytes;
    private readonly int _maxLifetimePins;
    private readonly int _maxReadLoans;
    private readonly ActorArenaBudget _budget;
    private readonly int _budgetBytes;
    private readonly Slot[] _slots;
    private readonly int[] _freeSlots;

    private byte* _persistent;
    private byte* _scratch;
    private int _nextSlot;
    private int _freeSlotCount;
    private int _liveAllocations;
    private int _persistentHighWater;
    private int _persistentLiveBytes;
    private int _scratchHighWater;
    private int _externalPins;
    private int _readLoans;
    private ulong _turnEpoch;
    private bool _turnActive;
    private bool _retired;
    private bool _reclaimed;
    private bool _budgetRefunded;

    public ActorArena(ulong actorId, ulong incarnation,
        int persistentBytes = 8 * 1024 * 1024,
        int scratchBytes = 1024 * 1024,
        int maxAllocations = 4096,
        int maxLifetimePins = 4096,
        int maxReadLoans = 4096,
        ActorArenaBudget? budget = null)
    {
        if (actorId == 0)
            throw new ArgumentOutOfRangeException(nameof(actorId));
        if (incarnation == 0)
            throw new ArgumentOutOfRangeException(nameof(incarnation));
        if (persistentBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(persistentBytes));
        if (scratchBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(scratchBytes));
        if (persistentBytes > MaxArenaBytes || scratchBytes > MaxArenaBytes ||
            persistentBytes > MaxArenaBytes - scratchBytes)
            throw new ArgumentOutOfRangeException(nameof(persistentBytes),
                "Actor arena persistent + scratch capacity exceeds 64 MiB");
        if (maxAllocations <= 0 || maxAllocations > MaxAllocationSlots)
            throw new ArgumentOutOfRangeException(nameof(maxAllocations));
        if (maxLifetimePins <= 0 || maxLifetimePins > MaxOutstandingLifetimePins)
            throw new ArgumentOutOfRangeException(nameof(maxLifetimePins));
        if (maxReadLoans <= 0 || maxReadLoans > MaxOutstandingReadLoans)
            throw new ArgumentOutOfRangeException(nameof(maxReadLoans));

        _actorId = actorId;
        _incarnation = incarnation;
        _persistentCapacity = persistentBytes;
        _scratchCapacity = scratchBytes;
        _persistentPhysicalBytes = RoundUp(persistentBytes, SlabAlignment);
        _scratchPhysicalBytes = RoundUp(scratchBytes, SlabAlignment);
        _maxLifetimePins = maxLifetimePins;
        _maxReadLoans = maxReadLoans;
        _budget = budget ?? ActorArenaBudget.Process;
        _budgetBytes = checked(_persistentPhysicalBytes + _scratchPhysicalBytes);
        _slots = new Slot[maxAllocations];
        _freeSlots = new int[maxAllocations];

        _budget.Reserve(_budgetBytes);
        try
        {
            _authority = Guid.NewGuid();
            if (_authority == Guid.Empty)
                throw new InvalidOperationException(
                    "Actor arena authority must not be empty");

            _persistent = (byte*)NativeMemory.AlignedAlloc(
                checked((nuint)_persistentPhysicalBytes), (nuint)SlabAlignment);
            if (_persistent == null)
                throw new OutOfMemoryException(
                    "Unable to reserve persistent actor arena");

            _scratch = (byte*)NativeMemory.AlignedAlloc(
                checked((nuint)_scratchPhysicalBytes), (nuint)SlabAlignment);
            if (_scratch == null)
                throw new OutOfMemoryException("Unable to reserve actor scratch arena");

            Zero(_persistent, _persistentPhysicalBytes);
            Zero(_scratch, _scratchPhysicalBytes);
        }
        catch
        {
            if (_scratch != null)
            {
                NativeMemory.AlignedFree(_scratch);
                _scratch = null;
            }
            if (_persistent != null)
            {
                NativeMemory.AlignedFree(_persistent);
                _persistent = null;
            }
            _budget.Refund(_budgetBytes);
            _budgetRefunded = true;
            throw;
        }
    }

    public ulong ActorId => _actorId;
    public ulong Incarnation => _incarnation;
    public int PersistentCapacityBytes => _persistentCapacity;
    public int ScratchCapacityBytes => _scratchCapacity;
    public int ReservedNativeBytes => _budgetBytes;

    public bool IsRetired
    {
        get { lock (_gate) return _retired; }
    }

    public bool IsReclaimed
    {
        get { lock (_gate) return _reclaimed; }
    }

    public int PersistentLiveBytes
    {
        get { lock (_gate) return _persistentLiveBytes; }
    }

    public int LiveAllocations
    {
        get { lock (_gate) return _liveAllocations; }
    }

    public int OutstandingReadLoans
    {
        get { lock (_gate) return _readLoans; }
    }

    public int OutstandingLifetimePins
    {
        get { lock (_gate) return _externalPins; }
    }

    /// <summary>
    /// Admit one physical turn. Actor identity is logical scheduler authority;
    /// carrier thread identity is intentionally irrelevant.
    /// </summary>
    public ActorArenaTurn EnterTurn(ulong actorId, ulong incarnation)
    {
        lock (_gate)
        {
            EnsureNotReclaimedLocked();
            if (_retired)
                throw new InvalidOperationException("Actor arena is retired");
            if (actorId != _actorId || incarnation != _incarnation)
                throw new InvalidOperationException("Foreign actor cannot enter arena");
            if (_turnActive)
                throw new InvalidOperationException("Actor already has an active physical turn");
            if (_turnEpoch == ulong.MaxValue)
                throw new OverflowException("Actor arena turn epoch exhausted");

            ulong nextEpoch = _turnEpoch + 1;
            var admitted = new ActorArenaTurn(
                this, _authority, _actorId, _incarnation, nextEpoch);
            _turnEpoch = nextEpoch;
            _turnActive = true;
            return admitted;
        }
    }

    /// <summary>
    /// Allocate persistent actor-private bytes. Returned storage is zeroed.
    /// Partial frees are non-compacting; the bump region resets only once all
    /// persistent allocations are gone.
    /// </summary>
    public ActorArenaHandle AllocatePersistent(ActorArenaTurn turn, int bytes,
        int alignment = 8)
    {
        if (bytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(bytes));
        ValidateAlignment(alignment);

        lock (_gate)
        {
            ValidateTurnLocked(turn);
            EnsureAdmissionOpenLocked();

            int aligned = AlignUp(_persistentHighWater, alignment);
            if (aligned > _persistentCapacity ||
                bytes > _persistentCapacity - aligned)
                throw new InvalidOperationException("Actor persistent arena capacity exhausted");

            if (_freeSlotCount == 0 && _nextSlot == _slots.Length)
                throw new InvalidOperationException("Actor persistent allocation slots exhausted");

            int slotId = _freeSlotCount != 0
                ? _freeSlots[--_freeSlotCount]
                : _nextSlot++;

            ref Slot slot = ref _slots[slotId];
            if (slot.Generation == 0)
                slot.Generation = 1;
            if (slot.Live)
                throw new InvalidOperationException("Actor arena slot accounting is corrupt");

            slot.Offset = aligned;
            slot.Length = bytes;
            slot.ReadLoans = 0;
            slot.Live = true;
            _persistentHighWater = checked(aligned + bytes);
            _persistentLiveBytes = checked(_persistentLiveBytes + bytes);
            _liveAllocations++;

            Zero(_persistent + aligned, bytes);
            return new ActorArenaHandle(_authority, slotId, slot.Generation,
                _actorId, _incarnation, bytes);
        }
    }

    /// <summary>
    /// Drop one persistent allocation. Live read loans prohibit mutation/drop.
    /// Generation increments before the slot is eligible for reuse.
    /// </summary>
    public void ReleasePersistent(ActorArenaTurn turn, ActorArenaHandle handle)
    {
        lock (_gate)
        {
            ValidateTurnLocked(turn);
            ref Slot slot = ref ValidateHandleLocked(handle);
            if (slot.ReadLoans != 0)
                throw new InvalidOperationException(
                    "Cannot drop actor allocation while a read loan is live");
            if (slot.Generation == ulong.MaxValue)
                throw new OverflowException("Actor allocation generation exhausted");

            Zero(_persistent + slot.Offset, slot.Length);
            _persistentLiveBytes -= slot.Length;
            _liveAllocations--;
            slot.Live = false;
            slot.Offset = 0;
            slot.Length = 0;
            slot.Generation++;

            _freeSlots[_freeSlotCount++] = handle.Slot;

            if (_liveAllocations == 0)
            {
                Zero(_persistent, _persistentPhysicalBytes);
                _persistentHighWater = 0;
                _persistentLiveBytes = 0;
            }
        }
    }

    public void Write(ActorArenaTurn turn, ActorArenaHandle handle, int offset,
        ReadOnlySpan<byte> source)
    {
        lock (_gate)
        {
            ValidateTurnLocked(turn);
            ref Slot slot = ref ValidateHandleLocked(handle);
            if (slot.ReadLoans != 0)
                throw new InvalidOperationException(
                    "Cannot mutate actor allocation while a read loan is live");
            ValidateRange(offset, source.Length, slot.Length);
            source.CopyTo(new Span<byte>(_persistent + slot.Offset + offset, source.Length));
        }
    }

    public void Read(ActorArenaTurn turn, ActorArenaHandle handle, int offset,
        Span<byte> destination)
    {
        lock (_gate)
        {
            ValidateTurnLocked(turn);
            ref Slot slot = ref ValidateHandleLocked(handle);
            ValidateRange(offset, destination.Length, slot.Length);
            new ReadOnlySpan<byte>(_persistent + slot.Offset + offset, destination.Length)
                .CopyTo(destination);
        }
    }

    /// <summary>
    /// Acquire a read loan that may survive turn exit. It freezes writes and
    /// drop of this allocation until released, but the loan cannot dereference
    /// bytes without a separately admitted owner turn.
    /// </summary>
    public ActorArenaReadLoan BorrowRead(ActorArenaTurn turn, ActorArenaHandle handle)
    {
        lock (_gate)
        {
            ValidateTurnLocked(turn);
            EnsureAdmissionOpenLocked();
            if (_readLoans == _maxReadLoans)
                throw new InvalidOperationException("Actor read-loan quota exhausted");

            ref Slot slot = ref ValidateHandleLocked(handle);
            var loan = new ActorArenaReadLoan(this, _authority, handle.Slot,
                handle.Generation, _actorId, _incarnation, handle.Length);
            slot.ReadLoans = checked(slot.ReadLoans + 1);
            _readLoans++;
            return loan;
        }
    }

    /// <summary>
    /// Pin only arena lifetime for a continuation/FFI/I/O owner. No memory
    /// authority is attached to this object.
    /// </summary>
    public ActorArenaLifetimePin AcquireLifetimePin(ActorArenaTurn turn)
    {
        lock (_gate)
        {
            ValidateTurnLocked(turn);
            EnsureAdmissionOpenLocked();
            if (_externalPins == _maxLifetimePins)
                throw new InvalidOperationException("Actor lifetime-pin quota exhausted");
            var pin = new ActorArenaLifetimePin(this, _authority);
            _externalPins++;
            return pin;
        }
    }

    public ActorScratchHandle AllocateScratch(ActorArenaTurn turn, int bytes,
        int alignment = 8)
    {
        if (bytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(bytes));
        ValidateAlignment(alignment);

        lock (_gate)
        {
            ValidateTurnLocked(turn);
            EnsureAdmissionOpenLocked();
            int aligned = AlignUp(_scratchHighWater, alignment);
            if (aligned > _scratchCapacity || bytes > _scratchCapacity - aligned)
                throw new InvalidOperationException("Actor scratch arena capacity exhausted");

            _scratchHighWater = checked(aligned + bytes);
            Zero(_scratch + aligned, bytes);
            return new ActorScratchHandle(_authority, turn.Epoch, aligned, bytes);
        }
    }

    public void WriteScratch(ActorArenaTurn turn, ActorScratchHandle handle,
        int offset, ReadOnlySpan<byte> source)
    {
        lock (_gate)
        {
            ValidateTurnLocked(turn);
            ValidateScratchLocked(handle);
            ValidateRange(offset, source.Length, handle.Length);
            source.CopyTo(new Span<byte>(_scratch + handle.Offset + offset, source.Length));
        }
    }

    public void ReadScratch(ActorArenaTurn turn, ActorScratchHandle handle,
        int offset, Span<byte> destination)
    {
        lock (_gate)
        {
            ValidateTurnLocked(turn);
            ValidateScratchLocked(handle);
            ValidateRange(offset, destination.Length, handle.Length);
            new ReadOnlySpan<byte>(_scratch + handle.Offset + offset, destination.Length)
                .CopyTo(destination);
        }
    }

    /// <summary>
    /// Seal new authority and try physical reclamation. Existing active turns
    /// may perform cleanup/read/drop, but cannot allocate, borrow, or pin after
    /// retirement. Physical bytes are retained until turns, loans, and pins are
    /// quiescent.
    /// </summary>
    public bool Retire()
    {
        lock (_gate)
        {
            if (_reclaimed)
                return true;
            _retired = true;
            return TryReclaimLocked();
        }
    }

    public bool TryReclaim()
    {
        lock (_gate)
        {
            if (_reclaimed)
                return true;
            if (!_retired)
                return false;
            return TryReclaimLocked();
        }
    }

    public void Dispose()
    {
        Retire();
    }

    internal void ReleaseTurn(ActorArenaTurn turn)
    {
        lock (_gate)
        {
            if (_reclaimed)
                throw new InvalidOperationException("Actor turn released after arena reclamation");
            if (!_turnActive || turn.Arena != this || turn.Authority != _authority ||
                turn.ActorId != _actorId || turn.Incarnation != _incarnation ||
                turn.Epoch != _turnEpoch)
                throw new InvalidOperationException("Stale or foreign actor turn release");

            if (_scratchHighWater != 0)
                Zero(_scratch, _scratchHighWater);
            _scratchHighWater = 0;
            _turnActive = false;
            TryReclaimLocked();
        }
    }

    internal void ReleaseReadLoan(ActorArenaReadLoan loan)
    {
        lock (_gate)
        {
            if (_reclaimed)
                throw new InvalidOperationException("Read loan outlived physical arena");
            if (loan.Authority != _authority || loan.ActorId != _actorId ||
                loan.Incarnation != _incarnation || loan.Slot < 0 ||
                loan.Slot >= _nextSlot)
                throw new InvalidOperationException("Foreign actor read loan release");

            ref Slot slot = ref _slots[loan.Slot];
            if (!slot.Live || slot.Generation != loan.Generation ||
                slot.ReadLoans <= 0 || _readLoans <= 0)
                throw new InvalidOperationException("Stale actor read loan release");

            slot.ReadLoans--;
            _readLoans--;
            TryReclaimLocked();
        }
    }

    internal void ReleaseLifetimePin(Guid authority)
    {
        lock (_gate)
        {
            if (_reclaimed)
                throw new InvalidOperationException("Lifetime pin outlived physical arena");
            if (authority != _authority || _externalPins <= 0)
                throw new InvalidOperationException("Foreign actor lifetime-pin release");
            _externalPins--;
            TryReclaimLocked();
        }
    }

    private ref Slot ValidateHandleLocked(ActorArenaHandle handle)
    {
        EnsureNotReclaimedLocked();
        if (handle.Authority != _authority || handle.ActorId != _actorId ||
            handle.Incarnation != _incarnation || handle.Slot < 0 ||
            handle.Slot >= _nextSlot)
            throw new InvalidOperationException("Foreign actor arena capability");

        ref Slot slot = ref _slots[handle.Slot];
        if (!slot.Live || slot.Generation != handle.Generation ||
            slot.Length != handle.Length)
            throw new InvalidOperationException("Stale actor arena capability");
        return ref slot;
    }

    private void ValidateScratchLocked(ActorScratchHandle handle)
    {
        EnsureNotReclaimedLocked();
        if (!_turnActive || handle.Authority != _authority ||
            handle.Epoch != _turnEpoch || handle.Epoch == 0 ||
            handle.Offset < 0 || handle.Length <= 0 ||
            handle.Offset > _scratchHighWater ||
            handle.Length > _scratchHighWater - handle.Offset)
            throw new InvalidOperationException("Stale actor scratch capability");
    }

    private void ValidateTurnLocked(ActorArenaTurn turn)
    {
        ArgumentNullException.ThrowIfNull(turn);
        EnsureNotReclaimedLocked();
        if (turn.Released || !_turnActive || turn.Arena != this ||
            turn.Authority != _authority || turn.ActorId != _actorId ||
            turn.Incarnation != _incarnation || turn.Epoch != _turnEpoch)
            throw new InvalidOperationException("Stale or foreign actor turn");
    }

    private void EnsureAdmissionOpenLocked()
    {
        if (_retired)
            throw new InvalidOperationException("Actor arena admission is retired");
    }

    private void EnsureNotReclaimedLocked()
    {
        if (_reclaimed)
            throw new ObjectDisposedException(nameof(ActorArena));
    }

    private bool TryReclaimLocked()
    {
        if (!_retired || _turnActive || _externalPins != 0 || _readLoans != 0)
            return false;

        if (_persistent != null)
        {
            Zero(_persistent, _persistentPhysicalBytes);
            NativeMemory.AlignedFree(_persistent);
            _persistent = null;
        }

        if (_scratch != null)
        {
            Zero(_scratch, _scratchPhysicalBytes);
            NativeMemory.AlignedFree(_scratch);
            _scratch = null;
        }

        if (!_budgetRefunded)
        {
            _budget.Refund(_budgetBytes);
            _budgetRefunded = true;
        }

        Array.Clear(_slots, 0, _slots.Length);
        Array.Clear(_freeSlots, 0, _freeSlots.Length);
        _nextSlot = 0;
        _freeSlotCount = 0;
        _liveAllocations = 0;
        _persistentHighWater = 0;
        _persistentLiveBytes = 0;
        _scratchHighWater = 0;
        _reclaimed = true;
        return true;
    }

    private static int RoundUp(int value, int alignment)
    {
        int remainder = value & (alignment - 1);
        return remainder == 0 ? value : checked(value + alignment - remainder);
    }

    private static int AlignUp(int value, int alignment)
    {
        int remainder = value & (alignment - 1);
        return remainder == 0 ? value : checked(value + alignment - remainder);
    }

    private static void ValidateAlignment(int alignment)
    {
        if (alignment <= 0 || alignment > SlabAlignment ||
            (alignment & (alignment - 1)) != 0)
            throw new ArgumentOutOfRangeException(nameof(alignment),
                "Alignment must be a power of two between 1 and 64");
    }

    private static void ValidateRange(int offset, int length, int capacity)
    {
        if (offset < 0 || length < 0 || offset > capacity ||
            length > capacity - offset)
            throw new ArgumentOutOfRangeException(nameof(offset),
                "Actor arena access is outside the allocation");
    }

    private static void Zero(byte* pointer, int length)
    {
        if (length <= 0)
            return;
        CryptographicOperations.ZeroMemory(new Span<byte>(pointer, length));
    }
}
