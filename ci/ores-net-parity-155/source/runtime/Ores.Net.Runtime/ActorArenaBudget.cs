namespace Ores.Net.Runtime;

/// <summary>
/// Aggregate reservation budget for actor-owned unmanaged arenas. Capacity is
/// charged before native allocation and refunded only after physical reclaim.
/// Multiple runtimes/tenants may provide distinct budget instances.
/// </summary>
public sealed class ActorArenaBudget
{
    public const long DefaultProcessLimitBytes = 1024L * 1024 * 1024;

    public static ActorArenaBudget Process { get; } =
        new(DefaultProcessLimitBytes);

    private readonly object _gate = new();
    private long _reservedBytes;

    public ActorArenaBudget(long limitBytes)
    {
        if (limitBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(limitBytes));
        LimitBytes = limitBytes;
    }

    public long LimitBytes { get; }

    public long ReservedBytes
    {
        get { lock (_gate) return _reservedBytes; }
    }

    internal void Reserve(int bytes)
    {
        if (bytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(bytes));

        lock (_gate)
        {
            if (_reservedBytes > LimitBytes - bytes)
                throw new InvalidOperationException(
                    "Aggregate actor arena native-memory budget exhausted");
            _reservedBytes += bytes;
        }
    }

    internal void Refund(int bytes)
    {
        if (bytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(bytes));

        lock (_gate)
        {
            if (_reservedBytes < bytes)
                throw new InvalidOperationException(
                    "Actor arena budget refund would underflow");
            _reservedBytes -= bytes;
        }
    }
}
