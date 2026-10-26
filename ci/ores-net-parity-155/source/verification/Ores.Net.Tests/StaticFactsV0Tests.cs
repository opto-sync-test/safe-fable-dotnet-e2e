using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Ores.Net.Compiler;

internal static class StaticFactsV0Tests
{
    private static void Require(bool condition, string reason)
    {
        if (!condition) throw new Exception("Static facts v0 regression: " + reason);
    }

    private static void Reject(Func<string> emit, string reason)
    {
        try { _ = emit(); }
        catch (FormatException) { return; }
        throw new Exception("Static facts unexpectedly accepted " + reason);
    }

    private static JsonElement Root(string json) =>
        JsonDocument.Parse(json).RootElement.Clone();

    public static void Run()
    {
        const string scalar = "fnc main():int{return 2+3*4;}";
        string first = StaticFactsV0Exporter.FromCompiledScalarSource(scalar);
        string second = StaticFactsV0Exporter.FromCompiledScalarSource(scalar);
        Require(first == second, "production scalar export deterministic");
        var root = Root(first);
        Require(root.GetProperty("version").GetString() == "ores-static-facts/v0",
            "shared schema version");
        string hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(scalar)))
            .ToLowerInvariant();
        Require(root.GetProperty("unit").GetString() == "sha256:" + hash,
            "exact Unicode UTF8 source identity");
        Require(root.GetProperty("procedures").GetArrayLength() == 1 &&
            root.GetProperty("procedures")[0].GetProperty("id").GetString() ==
            "__root__.main/0", "canonical Java/Rust procedure identity");
        Require(root.GetProperty("procedures")[0].GetProperty("loops").GetArrayLength() == 0,
            "shipping scalar frontend does not claim control flow");
        foreach (string name in new[] {
            "edges", "taint_sources", "flows", "sinks", "permission_checks"
        })
            Require(root.GetProperty(name).GetArrayLength() == 0,
                "scalar importer-compatible empty " + name);

        Require(StaticFactsV0Exporter.FromCompiledScalarSource(scalar + "\n") != first,
            "different source bytes cannot reuse fact identity");
        Reject(() => StaticFactsV0Exporter.FromCompiledScalarSource(
            "fnc main():int{return unbound;}"), "unverified name binding");
        Reject(() => StaticFactsV0Exporter.FromCompiledScalarSource(
            "fnc main():int{while true {} return 1;}"), "loops in production subset");
        Reject(() => StaticFactsV0Exporter.FromCompiledScalarSource(
            "fnc main():int{return 1 |> helper;}"), "unlowered pipelines");

        const string structured = """
            fnc main(): int {
                let int i = 0;
                while i < 10 {
                    i = i + 1;
                }
                return i;
            }
            """;
        var tree = Root(StaticFactsV0Exporter.FromStructuredSource(structured));
        var loops = tree.GetProperty("procedures")[0].GetProperty("loops");
        Require(loops.GetArrayLength() == 1 &&
            loops[0].GetProperty("id").GetString() == "L1" &&
            loops[0].GetProperty("exit").GetString() == "unknown" &&
            loops[0].GetProperty("safepoint").GetBoolean() == false,
            "typed while loop has unknown termination and no certified safepoint");
        Require(tree.GetProperty("edges").GetArrayLength() == 0,
            "structured subset never invents call effects");
        Require(tree.GetProperty("unit").GetString() ==
            "sha256:" + Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(structured))).ToLowerInvariant(),
            "structured path uses exact source text identity");

        var tooManyLoops = new StringBuilder("fnc main():int{\n");
        for (int i = 0; i < 257; i++) tooManyLoops.Append("while true { }\n");
        tooManyLoops.Append("return 0;}");
        Reject(() => StaticFactsV0Exporter.FromStructuredSource(tooManyLoops.ToString()),
            "downstream 256-loop budget");

        Reject(() => StaticFactsV0Exporter.FromStructuredSource(
            "fnc main():int{let bool go=true;while go { go = 1; } return 0;}"),
            "wrong-type assignment");
        Reject(() => StaticFactsV0Exporter.FromStructuredSource(
            "fnc main():int{return side_effect();}"),
            "unknown callable");
        Reject(() => StaticFactsV0Exporter.FromStructuredSource(
            "fnc main():int{return 0;}\nfnc evil():int{return 1;}"),
            "hidden trailing function");
        Reject(() => StaticFactsV0Exporter.FromStructuredSource(
            "\uFEFFfnc main():int{return 0;}"), "BOM source identity mismatch");
        Reject(() => StaticFactsV0Exporter.FromStructuredSource(
            "fnc main():int{return 0;}\0"), "NUL source");
        Reject(() => StaticFactsV0Exporter.FromCompiledScalarSource(
            new string(' ', 1_048_577)), "excessive source bytes");
    }
}
