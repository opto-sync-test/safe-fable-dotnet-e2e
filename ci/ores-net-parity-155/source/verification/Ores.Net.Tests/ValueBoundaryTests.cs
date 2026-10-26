using Ores.Net.Compiler;
using System.Text.Json;

internal static class ValueBoundaryTests
{
    public static void Run()
    {
        const string control = "pub fnc main():int{return (5+3)*7-14;}";
        _ = OresParser.Parse(control);
        _ = OresStructuredParser.Parse(control);
        var path = Path.Combine(AppContext.BaseDirectory, "value-boundary-rejections.json");
        var cases = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path))
            ?? throw new Exception("Missing boundary corpus");
        if (cases.Count != 15) throw new Exception("Incomplete boundary corpus");
        foreach (var (name, source) in cases)
        {
            Reject(() => { _ = OresParser.Parse(source); }, name + "/shipping");
            Reject(() => { _ = OresStructuredParser.Parse(source); }, name + "/structured");
        }
        var taskPath = Path.Combine(AppContext.BaseDirectory, "cpu-gpu-task-unsupported-v2.json");
        var taskCases = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(taskPath))
            ?? throw new Exception("Missing CPU/GPU task v2 corpus");
        if (taskCases.Count != 10) throw new Exception("Incomplete CPU/GPU task v2 corpus");
        foreach (var (name, source) in taskCases)
        {
            Reject(() => { _ = OresParser.Parse(source); }, name + "/task-v2/shipping");
            Reject(() => { _ = OresStructuredParser.Parse(source); }, name + "/task-v2/structured");
        }
        // Stronger than generic parse failure: ordinary borrowed task
        // captures must stop at the contextual Task boundary until there
        // is a typed Send/Sync/loan and physical-quiescence lowering.
        var borrowCases = new Dictionary<string, string>
        {
            ["shared-borrow"] = "pub fnc main(int owner):int{return task { return rt borrow owner; };}",
            ["exclusive-borrow"] = "pub fnc main(int owner):int{return task { return rt mut borrow owner; };}",
            ["nested-borrow"] = "pub fnc main(int owner):int{return task { return task { return rt borrow owner; }; };}",
            ["task-comment-line"] = "pub fnc main(int owner):int{return task // hidden boundary\n { return rt borrow owner; };}",
            ["task-comment-block"] = "pub fnc main(int owner):int{return task /* comment */ { return rt borrow owner; };}",
            ["task-comment-nested"] = "pub fnc main(int owner):int{return task /* outer /* inner */ outer */ { return rt borrow owner; };}",
            ["task-multiline"] = "pub fnc main(int owner):int{return task \n { return rt borrow owner; };}",
            ["classic-for-init-borrow"] = "pub fnc main(int owner):int{return task { for (val loop = rt borrow owner; false; ) {} return 0; };}"
        };
        foreach (var (name, source) in borrowCases)
        {
            RejectTaskBorrow(() => { _ = OresParser.Parse(source); }, name + "/shipping");
            RejectTaskBorrow(() => { _ = OresStructuredParser.Parse(source); }, name + "/structured");
        }
        Console.WriteLine($"{cases.Count} value boundary + {taskCases.Count} CPU/GPU task v2 + {borrowCases.Count} borrowed Task cases rejected by both frontends");
    }

    private static void RejectTaskBorrow(Action parse, string name)
    {
        try { parse(); }
        catch (FormatException error)
        {
            if (!error.Message.Contains("execution task", StringComparison.OrdinalIgnoreCase))
                throw new Exception(name + ": rejection must occur at Task admission, got " + error.Message);
            return;
        }
        throw new Exception(name + ": borrowed Task was admitted without ownership proof");
    }

    private static void Reject(Action parse, string name)
    {
        try { parse(); }
        catch (FormatException error)
        {
            if (string.IsNullOrWhiteSpace(error.Message))
                throw new Exception(name + ": missing diagnostic");
            return;
        }
        throw new Exception(name + ": unsupported source admitted");
    }
}
