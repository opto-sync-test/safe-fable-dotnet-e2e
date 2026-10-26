using Ores.Net.Runtime;

internal static class ActorArenaSelfTest
{
    public static void Run()
    {
        PersistentAndScratchLifetimes();
        ReadLoanFreezesAllocationAcrossTurns();
        LifetimePinDelaysPhysicalReclaim();
        AggregateBudgetAdmissionIsNeutral();
        RetirementSealsAdmissionButAllowsTurnCleanup();
        CrossArenaAuthorityAndGenerationFences();
        Console.WriteLine("PASS .NET actor-owned unmanaged arena, loans, pins and quiescent reclaim");
    }

    private static void PersistentAndScratchLifetimes()
    {
        using var arena = new ActorArena(
            actorId: 1001, incarnation: 7,
            persistentBytes: 4096, scratchBytes: 512,
            maxAllocations: 16, maxLifetimePins: 8, maxReadLoans: 8);

        ActorArenaHandle persistent;
        ActorScratchHandle scratch;
        using (var turn = arena.EnterTurn(1001, 7))
        {
            persistent = arena.AllocatePersistent(turn, 16, alignment: 8);
            arena.Write(turn, persistent, 0, new byte[] { 1, 2, 3, 4 });

            scratch = arena.AllocateScratch(turn, 16, alignment: 16);
            arena.WriteScratch(turn, scratch, 0, new byte[] { 9, 8, 7, 6 });

            var p = new byte[4];
            var s = new byte[4];
            arena.Read(turn, persistent, 0, p);
            arena.ReadScratch(turn, scratch, 0, s);
            Require(p.AsSpan().SequenceEqual(new byte[] { 1, 2, 3, 4 }),
                "persistent bytes round trip");
            Require(s.AsSpan().SequenceEqual(new byte[] { 9, 8, 7, 6 }),
                "scratch bytes round trip");

            ExpectInvalid(() => arena.EnterTurn(1001, 7),
                "second simultaneous actor turn");
        }

        using (var resumed = arena.EnterTurn(1001, 7))
        {
            var p = new byte[4];
            arena.Read(resumed, persistent, 0, p);
            Require(p.AsSpan().SequenceEqual(new byte[] { 1, 2, 3, 4 }),
                "persistent bytes survive carrier/turn rollover");

            ExpectInvalid(() =>
            {
                var one = new byte[1];
                arena.ReadScratch(resumed, scratch, 0, one);
            }, "scratch capability must die at turn exit");

            var freshScratch = arena.AllocateScratch(resumed, 512, alignment: 8);
            var oneByte = new byte[1];
            arena.ReadScratch(resumed, freshScratch, 0, oneByte);
            Require(oneByte[0] == 0, "reused scratch capacity is zeroed");
        }

        ExpectInvalid(() => arena.EnterTurn(9999, 7), "wrong actor id");
        ExpectInvalid(() => arena.EnterTurn(1001, 8), "wrong actor incarnation");

        using var cleanup = arena.EnterTurn(1001, 7);
        arena.ReleasePersistent(cleanup, persistent);
        Require(arena.PersistentLiveBytes == 0 && arena.LiveAllocations == 0,
            "persistent quota refunded after final drop");
    }

    private static void ReadLoanFreezesAllocationAcrossTurns()
    {
        using var arena = new ActorArena(
            actorId: 2001, incarnation: 3,
            persistentBytes: 2048, scratchBytes: 256,
            maxAllocations: 8, maxLifetimePins: 4, maxReadLoans: 4);

        ActorArenaHandle handle;
        ActorArenaReadLoan loan;
        using (var turn = arena.EnterTurn(2001, 3))
        {
            handle = arena.AllocatePersistent(turn, 8);
            arena.Write(turn, handle, 0, new byte[] { 42, 0, 0, 0, 0, 0, 0, 0 });
            loan = arena.BorrowRead(turn, handle);
            Require(arena.OutstandingReadLoans == 1, "read loan charged");
        }

        using (var resumed = arena.EnterTurn(2001, 3))
        {
            var value = new byte[1];
            arena.Read(resumed, handle, 0, value);
            Require(value[0] == 42, "loaned persistent value survives suspension");

            ExpectInvalid(() => arena.Write(resumed, handle, 0, new byte[] { 99 }),
                "live shared/read loan blocks mutation");
            ExpectInvalid(() => arena.ReleasePersistent(resumed, handle),
                "live shared/read loan blocks drop");
        }

        Task.Run(loan.Dispose).GetAwaiter().GetResult();
        loan.Dispose();
        Require(arena.OutstandingReadLoans == 0,
            "off-carrier idempotent read-loan release");

        using var finalTurn = arena.EnterTurn(2001, 3);
        arena.Write(finalTurn, handle, 0, new byte[] { 55 });
        var check = new byte[1];
        arena.Read(finalTurn, handle, 0, check);
        Require(check[0] == 55, "mutation resumes after read loan release");
        arena.ReleasePersistent(finalTurn, handle);
    }

    private static void LifetimePinDelaysPhysicalReclaim()
    {
        var arena = new ActorArena(
            actorId: 3001, incarnation: 11,
            persistentBytes: 1024, scratchBytes: 256,
            maxAllocations: 4, maxLifetimePins: 2, maxReadLoans: 2);

        ActorArenaLifetimePin pin;
        using (var turn = arena.EnterTurn(3001, 11))
        {
            _ = arena.AllocatePersistent(turn, 32);
            pin = arena.AcquireLifetimePin(turn);
        }

        Require(!arena.Retire(), "lifetime pin must delay physical reclaim");
        Require(arena.IsRetired && !arena.IsReclaimed,
            "logical retirement precedes physical reclaim");
        ExpectInvalid(() => arena.EnterTurn(3001, 11),
            "retired arena must reject a new turn");

        Task.Run(pin.Dispose).GetAwaiter().GetResult();
        pin.Dispose();
        Require(arena.IsReclaimed, "last lifetime pin triggers physical reclaim");
        Require(arena.TryReclaim(), "reclaim is idempotent after physical release");
        arena.Dispose();
    }

    private static void AggregateBudgetAdmissionIsNeutral()
    {
        const int reserved = 1280;
        var budget = new ActorArenaBudget(reserved);

        var first = new ActorArena(
            actorId: 3501, incarnation: 1,
            persistentBytes: 1024, scratchBytes: 256,
            maxAllocations: 4, maxLifetimePins: 2, maxReadLoans: 2,
            budget: budget);
        Require(first.ReservedNativeBytes == reserved &&
            budget.ReservedBytes == reserved,
            "arena reserves aggregate native capacity before use");

        ExpectInvalid(() => _ = new ActorArena(
            actorId: 3502, incarnation: 1,
            persistentBytes: 1024, scratchBytes: 256,
            maxAllocations: 4, maxLifetimePins: 2, maxReadLoans: 2,
            budget: budget),
            "aggregate budget denies second arena");
        Require(budget.ReservedBytes == reserved,
            "failed aggregate admission is accounting-neutral");

        Require(first.Retire(), "quiescent arena reclaims immediately");
        Require(budget.ReservedBytes == 0,
            "physical reclaim refunds aggregate arena capacity");
        first.Dispose();

        var replacement = new ActorArena(
            actorId: 3503, incarnation: 1,
            persistentBytes: 1024, scratchBytes: 256,
            maxAllocations: 4, maxLifetimePins: 2, maxReadLoans: 2,
            budget: budget);
        Require(budget.ReservedBytes == reserved,
            "refunded native capacity can be admitted by a new actor");
        replacement.Dispose();
        Require(budget.ReservedBytes == 0,
            "replacement retirement refunds exactly once");

        var tooSmall = new ActorArenaBudget(reserved - 1);
        ExpectInvalid(() => _ = new ActorArena(
            actorId: 3504, incarnation: 1,
            persistentBytes: 1024, scratchBytes: 256,
            maxAllocations: 4, maxLifetimePins: 2, maxReadLoans: 2,
            budget: tooSmall),
            "constructor rejected by aggregate budget");
        Require(tooSmall.ReservedBytes == 0,
            "rejected constructor consumes no aggregate reservation");
    }

    private static void RetirementSealsAdmissionButAllowsTurnCleanup()
    {
        var arena = new ActorArena(
            actorId: 4001, incarnation: 2,
            persistentBytes: 1024, scratchBytes: 256,
            maxAllocations: 4, maxLifetimePins: 2, maxReadLoans: 2);

        using (var turn = arena.EnterTurn(4001, 2))
        {
            var handle = arena.AllocatePersistent(turn, 16);
            arena.Write(turn, handle, 0, new byte[] { 1, 2, 3, 4 });

            Require(!arena.Retire(), "active turn must delay reclaim");
            ExpectInvalid(() => arena.AllocatePersistent(turn, 8),
                "retirement seals new persistent allocation");
            ExpectInvalid(() => arena.AllocateScratch(turn, 8),
                "retirement seals new scratch allocation");
            ExpectInvalid(() => arena.AcquireLifetimePin(turn),
                "retirement seals new lifetime pins");
            ExpectInvalid(() => arena.BorrowRead(turn, handle),
                "retirement seals new read loans");

            var bytes = new byte[4];
            arena.Read(turn, handle, 0, bytes);
            Require(bytes.AsSpan().SequenceEqual(new byte[] { 1, 2, 3, 4 }),
                "existing turn can finish cleanup after logical retirement");
            arena.ReleasePersistent(turn, handle);
        }

        Require(arena.IsReclaimed,
            "turn exit after retirement performs quiescent physical reclaim");
        arena.Dispose();
    }

    private static void CrossArenaAuthorityAndGenerationFences()
    {
        using var left = new ActorArena(
            actorId: 5001, incarnation: 1,
            persistentBytes: 1024, scratchBytes: 128,
            maxAllocations: 4, maxLifetimePins: 2, maxReadLoans: 2);
        using var right = new ActorArena(
            actorId: 5001, incarnation: 1,
            persistentBytes: 1024, scratchBytes: 128,
            maxAllocations: 4, maxLifetimePins: 2, maxReadLoans: 2);

        ActorArenaHandle stale;
        using (var leftTurn = left.EnterTurn(5001, 1))
        {
            stale = left.AllocatePersistent(leftTurn, 8);
            left.Write(leftTurn, stale, 0,
                new byte[] { 7, 7, 7, 7, 7, 7, 7, 7 });
            left.ReleasePersistent(leftTurn, stale);

            var replacement = left.AllocatePersistent(leftTurn, 8);
            var zeroed = new byte[8];
            left.Read(leftTurn, replacement, 0, zeroed);
            Require(zeroed.All(static b => b == 0),
                "reused persistent capacity is scrubbed");

            ExpectInvalid(() =>
            {
                var value = new byte[1];
                left.Read(leftTurn, stale, 0, value);
            }, "stale generation replay");

            left.ReleasePersistent(leftTurn, replacement);
        }

        using var rightTurn = right.EnterTurn(5001, 1);
        ExpectInvalid(() =>
        {
            var value = new byte[1];
            right.Read(rightTurn, stale, 0, value);
        }, "same numeric actor identity cannot cross arena authority");
    }

    private static void ExpectInvalid(Action action, string scenario)
    {
        try
        {
            action();
        }
        catch (InvalidOperationException)
        {
            return;
        }

        throw new Exception("Actor arena unexpectedly admitted: " + scenario);
    }

    private static void Require(bool condition, string scenario)
    {
        if (!condition)
            throw new Exception("Actor arena regression: " + scenario);
    }
}
