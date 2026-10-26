using Ores.Net.Runtime;

internal static class ActorShardColumnsSelfTest
{
    public static void Run()
    {
        foreach (ActorDataLayout layout in Enum.GetValues<ActorDataLayout>())
            ExerciseLayout(layout);

        Reject(() =>
        {
            using var arena = NewArena(6100);
            using var turn = arena.EnterTurn(6100, 1);
            _ = new ActorShardColumns(arena, turn, 8, 3,
                ActorDataLayout.Aosoa, lanes: 3);
        }, "non-power-of-two AoSoA lane width");

        Reject(() =>
        {
            using var arena = NewArena(6101);
            using var turn = arena.EnterTurn(6101, 1);
            _ = new ActorShardColumns(arena, turn, 8, 3,
                ActorDataLayout.Soa, lanes: 4);
        }, "SoA cannot pretend to carry AoSoA lane metadata");

        Console.WriteLine("PASS .NET actor-owned AoS/SoA/AoSoA shard layouts and dense kernel");
    }

    private static void ExerciseLayout(ActorDataLayout layout)
    {
        ulong actorId = 6000UL + (ulong)layout;
        using var arena = NewArena(actorId);
        using var turn = arena.EnterTurn(actorId, 1);
        int lanes = layout == ActorDataLayout.Aosoa ? 4 : 1;
        var shard = new ActorShardColumns(arena, turn,
            rows: 7, fields: 3, layout, lanes);

        Require(shard.Rows == 7 && shard.Fields == 3,
            layout + " logical dimensions");
        Require(shard.ByteLength <= ActorShardColumns.MaxShardBytes,
            layout + " bounded physical bytes");
        if (layout == ActorDataLayout.Aosoa)
            Require(shard.PhysicalRows == 8,
                "AoSoA pads to the next tile without changing logical rows");

        for (int row = 0; row < shard.Rows; row++)
        {
            shard.Write(turn, row, 0, row * 10.0);
            shard.Write(turn, row, 1, row + 0.5);
            shard.Write(turn, row, 2, 1000.0 + row);
        }

        for (int row = 0; row < shard.Rows; row++)
        {
            Require(shard.Read(turn, row, 0) == row * 10.0,
                layout + " field 0 mapping");
            Require(shard.Read(turn, row, 1) == row + 0.5,
                layout + " field 1 mapping");
            Require(shard.Read(turn, row, 2) == 1000.0 + row,
                layout + " field 2 mapping");
        }

        shard.Integrate(turn, positionField: 0, velocityField: 1, dt: 0.25);
        var column = new double[shard.Rows];
        shard.CopyColumnInto(turn, 0, column);
        for (int row = 0; row < column.Length; row++)
        {
            double expected = row * 10.0 + (row + 0.5) * 0.25;
            Require(column[row] == expected,
                layout + " dense integrate/copy parity row " + row);
        }

        Reject(() => shard.Read(turn, -1, 0),
            layout + " negative row bounds");
        Reject(() => shard.Read(turn, 0, 3),
            layout + " field bounds");

        shard.Release(turn);
        Require(arena.PersistentLiveBytes == 0,
            layout + " release refunds actor arena bytes");
        Reject(() => shard.Read(turn, 0, 0),
            layout + " released shard cannot be reused");
    }

    private static ActorArena NewArena(ulong actorId) => new(
        actorId, incarnation: 1,
        persistentBytes: 2 * 1024 * 1024,
        scratchBytes: 64 * 1024,
        maxAllocations: 32,
        maxLifetimePins: 8,
        maxReadLoans: 8);

    private static void Reject(Action action, string scenario)
    {
        try
        {
            action();
        }
        catch (ArgumentException)
        {
            return;
        }
        catch (InvalidOperationException)
        {
            return;
        }

        throw new Exception("Actor shard unexpectedly admitted: " + scenario);
    }

    private static void Require(bool condition, string scenario)
    {
        if (!condition)
            throw new Exception("Actor shard regression: " + scenario);
    }
}
