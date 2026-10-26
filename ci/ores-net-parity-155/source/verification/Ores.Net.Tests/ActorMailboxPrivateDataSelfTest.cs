using Ores.Net.Runtime;

// Limited to the existing byte-only mailbox; this is not structural Sendable
// admission, persistent collections, or logical heap isolation in the CLR.
internal static class ActorMailboxPrivateDataSelfTest
{
    public static void Run()
    {
        var left = new ActorMailbox(9100, maxMessages: 2, maxQueuedBytes: 8);
        var right = new ActorMailbox(9100, maxMessages: 2, maxQueuedBytes: 8);
        var leftRef = left.CurrentRef;
        var rightRef = right.CurrentRef;
        if (leftRef == rightRef)
            throw new Exception("same numeric IDs accidentally share authority");

        var callerOwned = new byte[] { 11, 22, 33 };
        left.Send(leftRef, callerOwned);
        right.Send(rightRef, callerOwned);
        callerOwned[0] = 99;
        if (!left.TryReceive(out var first) || first is null ||
            !right.TryReceive(out var second) || second is null)
            throw new Exception("accepted data was lost");
        if (first.Length != 3 || second.Length != 3 ||
            first[0] != 11 || second[0] != 11)
            throw new Exception("sender mutation escaped byte-copy admission");
        if (ReferenceEquals(first, second) || ReferenceEquals(first, callerOwned) ||
            ReferenceEquals(second, callerOwned))
            throw new Exception("receiver payloads share mutable storage");

        first[1] = 77;
        if (second[1] != 22)
            throw new Exception("receivers were aliased across mailboxes");

        left.Send(leftRef, new byte[] { 7 });
        left.Stop();
        var newLeftRef = left.Restart();
        if (left.TryReceive(out _) || left.QueuedMessages != 0)
            throw new Exception("stale generation leaked queued message");
        try
        {
            left.Send(leftRef, new byte[] { 1 });
            throw new Exception("stale actor reference unexpectedly accepted");
        }
        catch (InvalidOperationException) { }

        // Rotating another mailbox's generation cannot revoke or overwrite
        // the independent receiver even if the numeric actor ID is identical.
        right.Send(rightRef, new byte[] { 4, 5 });
        left.Send(newLeftRef, new byte[] { 6 });
        if (!right.TryReceive(out var stillRight) || stillRight is null ||
            stillRight.Length != 2 || stillRight[0] != 4)
            throw new Exception("unrelated mailbox restart changed receiver state");
        if (!left.TryReceive(out var stillLeft) || stillLeft is null ||
            stillLeft.Length != 1 || stillLeft[0] != 6)
            throw new Exception("fresh mailbox incarnation could not receive");
        Console.WriteLine("PASS .NET isolated byte snapshots, cross-mailbox mutation and incarnation fencing");
    }
}
