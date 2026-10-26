using Ores.Net.Runtime;

// Permission must be evaluated before length or quota information is disclosed.
// This is a host-local capability boundary, not a remote actor wire decoder.
internal static class ActorMailboxAuthorizationPrioritySelfTest
{
    public static void Run()
    {
        var actor = new ActorMailbox(7301, maxMessages: 2, maxQueuedBytes: 4);
        var sameIdOther = new ActorMailbox(7301, maxMessages: 2, maxQueuedBytes: 4);
        var live = actor.CurrentRef;
        var invalid = sameIdOther.CurrentRef;
        var tooLarge = new byte[ActorMailbox.MaxMessageBytes + 1];

        static void DenyStale(Action send, string scenario)
        {
            try { send(); }
            catch (InvalidOperationException) { return; }
            throw new Exception("Invalid authority bypassed precedence: " + scenario);
        }
        static void DenyLength(Action send, string scenario)
        {
            try { send(); }
            catch (ArgumentOutOfRangeException) { return; }
            throw new Exception("Valid authority bypassed maximum length: " + scenario);
        }
        DenyStale(() => actor.Send(invalid, tooLarge), "same-id foreign mailbox");
        DenyStale(() => actor.Send(default, tooLarge), "default actor reference");
        DenyLength(() => actor.Send(live, tooLarge), "valid actor reference");
        if (actor.QueuedMessages != 0) throw new Exception("Rejected send mutated queue");

        actor.Stop();
        DenyStale(() => actor.Send(live, tooLarge), "closed receiver");
        var renewed = actor.Restart();
        DenyStale(() => actor.Send(live, tooLarge), "revoked generation");
        DenyLength(() => actor.Send(renewed, tooLarge), "renewed capability");
        actor.Send(renewed, new byte[] { 10, 11 });
        if (!actor.TryReceive(out var delivered) || delivered is null ||
            delivered.Length != 2 || delivered[0] != 10 || delivered[1] != 11)
            throw new Exception("Valid mailbox admission regressed");
        Console.WriteLine("PASS .NET authorization-first mailbox admission and capability revocation");
    }
}
