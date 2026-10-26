using Ores.Net.Runtime;
using System.Reflection;

internal static class ActorMailboxRestartAtomicitySelfTest
{
    public static void Run()
    {
        var box = new ActorMailbox(8501);
        var initial = box.CurrentRef;
        box.Send(initial, new byte[] { 1, 2, 3 });
        var field = typeof(ActorMailbox).GetField("_nextNonce", BindingFlags.NonPublic | BindingFlags.Instance)!;
        field.SetValue(box, (Func<Guid>)(() => throw new InvalidOperationException("simulated failure")));
        var rejected = false;
        try { box.Restart(); } catch (InvalidOperationException) { rejected = true; }
        if (!rejected || box.CurrentRef != initial || box.QueuedMessages != 1)
            throw new Exception("failed restart changed actor state");
        box.Send(initial, new byte[] { 4 });
        if (!box.TryReceive(out var data) || data is null || data.Length != 3 || data[0] != 1)
            throw new Exception("failed restart lost queued bytes");
        if (!box.TryReceive(out var second) || second is null || second.Length != 1 || second[0] != 4)
            throw new Exception("failed restart lost newly delivered data");

        box.Stop();
        var stoppedRef = box.CurrentRef;
        if (box.QueuedMessages != 0) throw new Exception("stop did not drain");
        rejected = false;
        try { box.Restart(); } catch (InvalidOperationException) { rejected = true; }
        if (!rejected || box.CurrentRef != stoppedRef || box.QueuedMessages != 0)
            throw new Exception("failed stopped restart changed mailbox state");
        rejected = false;
        try { box.Send(stoppedRef, new byte[] { 5 }); }
        catch (InvalidOperationException) { rejected = true; }
        if (!rejected) throw new Exception("failed stopped restart reopened mailbox");

        field.SetValue(box, (Func<Guid>)(() => Guid.Empty));
        rejected = false;
        try { box.Restart(); } catch (InvalidOperationException) { rejected = true; }
        if (!rejected || box.CurrentRef != stoppedRef)
            throw new Exception("empty nonce invalidated stopped actor");
        field.SetValue(box, (Func<Guid>)Guid.NewGuid);
        var revived = box.Restart();
        if (revived == stoppedRef) throw new Exception("restart failed to rotate authority");
        box.Send(revived, new byte[] { 6 });
        if (!box.TryReceive(out var payload) || payload is null || payload.Length != 1 || payload[0] != 6)
            throw new Exception("post-failure restart cannot deliver data");
        Console.WriteLine("PASS injected nonce failure open/stopped and invalid-authority recovery");
    }
}
