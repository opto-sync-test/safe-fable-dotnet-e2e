using System.Buffers.Binary;

namespace Ores.Net.Runtime;

public enum ActorDataLayout
{
    Aos,
    Soa,
    Aosoa
}

/// <summary>
/// Actor-owned dense homogeneous scalar shard backed by ActorArena unmanaged
/// storage. Exactly one physical layout is authoritative at a time: AoS, SoA,
/// or tiled AoSoA. This is the .NET host substrate for future inverted-class,
/// ECS, and data-oriented lowering; it is not yet source-language lowering.
/// </summary>
public sealed class ActorShardColumns
{
    public const int MaxShardBytes = 16 * 1024 * 1024;
    public const int MaxAosoaLanes = 1024;

    private readonly ActorArena _arena;
    private readonly ActorArenaHandle _storage;
    private bool _released;

    public ActorShardColumns(ActorArena arena, ActorArenaTurn turn,
        int rows, int fields, ActorDataLayout layout, int lanes = 1)
    {
        ArgumentNullException.ThrowIfNull(arena);
        ArgumentNullException.ThrowIfNull(turn);
        if (rows <= 0)
            throw new ArgumentOutOfRangeException(nameof(rows));
        if (fields <= 0)
            throw new ArgumentOutOfRangeException(nameof(fields));

        if (layout == ActorDataLayout.Aosoa)
        {
            if (lanes <= 0 || lanes > MaxAosoaLanes ||
                (lanes & (lanes - 1)) != 0)
                throw new ArgumentOutOfRangeException(nameof(lanes),
                    "AoSoA lanes must be a power of two from 1 through 1024");
        }
        else if (lanes != 1)
        {
            throw new ArgumentOutOfRangeException(nameof(lanes),
                "AoS and SoA use a lane width of one");
        }

        Rows = rows;
        Fields = fields;
        Layout = layout;
        Lanes = lanes;
        PhysicalRows = layout == ActorDataLayout.Aosoa
            ? RoundRows(rows, lanes)
            : rows;

        long scalars = checked((long)PhysicalRows * fields);
        long byteLength = checked(scalars * sizeof(double));
        if (byteLength > MaxShardBytes)
            throw new ArgumentOutOfRangeException(nameof(rows),
                "Actor shard exceeds the 16 MiB per-shard limit");

        ByteLength = checked((int)byteLength);
        _arena = arena;
        _storage = arena.AllocatePersistent(turn, ByteLength, alignment: 8);
    }

    public int Rows { get; }
    public int Fields { get; }
    public int PhysicalRows { get; }
    public int Lanes { get; }
    public int ByteLength { get; }
    public ActorDataLayout Layout { get; }

    public double Read(ActorArenaTurn turn, int row, int field)
    {
        EnsureLive();
        Span<byte> bytes = stackalloc byte[sizeof(long)];
        _arena.Read(turn, _storage, ByteOffset(row, field), bytes);
        long bits = BinaryPrimitives.ReadInt64LittleEndian(bytes);
        return BitConverter.Int64BitsToDouble(bits);
    }

    public void Write(ActorArenaTurn turn, int row, int field, double value)
    {
        EnsureLive();
        Span<byte> bytes = stackalloc byte[sizeof(long)];
        BinaryPrimitives.WriteInt64LittleEndian(
            bytes, BitConverter.DoubleToInt64Bits(value));
        _arena.Write(turn, _storage, ByteOffset(row, field), bytes);
    }

    /// <summary>
    /// Dense in-actor kernel with no per-row actor/Future allocation. This is a
    /// reference host kernel, not a claim of SIMD/vectorized code generation.
    /// </summary>
    public void Integrate(ActorArenaTurn turn, int positionField,
        int velocityField, double dt)
    {
        EnsureLive();
        if (positionField < 0 || positionField >= Fields ||
            velocityField < 0 || velocityField >= Fields ||
            positionField == velocityField)
            throw new ArgumentOutOfRangeException(nameof(positionField),
                "Integrate requires two distinct valid fields");
        if (!double.IsFinite(dt))
            throw new ArgumentOutOfRangeException(nameof(dt));

        for (int row = 0; row < Rows; row++)
        {
            double position = Read(turn, row, positionField);
            double velocity = Read(turn, row, velocityField);
            Write(turn, row, positionField, position + velocity * dt);
        }
    }

    /// <summary>
    /// Allocation-free copy into caller-owned storage. Detached snapshots with
    /// untracked lifetime are intentionally not provided by this API.
    /// </summary>
    public void CopyColumnInto(ActorArenaTurn turn, int field,
        Span<double> destination)
    {
        EnsureLive();
        if (field < 0 || field >= Fields)
            throw new ArgumentOutOfRangeException(nameof(field));
        if (destination.Length < Rows)
            throw new ArgumentException("Destination is smaller than the shard column",
                nameof(destination));

        for (int row = 0; row < Rows; row++)
            destination[row] = Read(turn, row, field);
    }

    /// <summary>
    /// Deterministically release this shard while its owning actor turn is
    /// admitted. The underlying bytes are zeroed before the slot is reusable.
    /// </summary>
    public void Release(ActorArenaTurn turn)
    {
        if (_released)
            return;
        _arena.ReleasePersistent(turn, _storage);
        _released = true;
    }

    private int ByteOffset(int row, int field)
    {
        if ((uint)row >= (uint)Rows)
            throw new ArgumentOutOfRangeException(nameof(row));
        if ((uint)field >= (uint)Fields)
            throw new ArgumentOutOfRangeException(nameof(field));

        long scalar = Layout switch
        {
            ActorDataLayout.Aos => checked((long)row * Fields + field),
            ActorDataLayout.Soa => checked((long)field * Rows + row),
            ActorDataLayout.Aosoa => checked(
                (((long)(row / Lanes) * Fields + field) * Lanes) +
                (row % Lanes)),
            _ => throw new InvalidOperationException("Unknown actor shard layout")
        };

        return checked((int)(scalar * sizeof(double)));
    }

    private void EnsureLive()
    {
        if (_released)
            throw new ObjectDisposedException(nameof(ActorShardColumns));
    }

    private static int RoundRows(int rows, int lanes)
    {
        int remainder = rows & (lanes - 1);
        return remainder == 0 ? rows : checked(rows + lanes - remainder);
    }
}
