using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Mono.Cecil;
using Ores.Net.Compiler;

// This is a REAL compiler frontend -> typed IR -> emitted CIL / reference
// interpreter check. It does not assert execution of a Native AOT binary.
internal static class SourceI64Conformance
{
    private const string ReviewedBlob = "bbc319c19ecd007109d33592e210091eb267e5a2";
    private const string ReviewedSha256 = "39bddbe558ad1c336271f91e6403c4555f2f16a7ed33a3355ee897721b6ab02a";
    private static readonly string[] ExpectedIds =
    {
        "precedence", "grouping", "signed-multiplication", "subtraction",
        "negative-result", "max-minus-one", "signed-minimum"
    };

    private static void Require(bool valid, string message)
    {
        if (!valid) throw new InvalidOperationException("source-i64 contract: " + message);
    }

    private static void ExactProperties(JsonElement element, params string[] names)
    {
        Require(element.ValueKind == JsonValueKind.Object, "expected JSON object");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
            Require(seen.Add(property.Name), "duplicate JSON property: " + property.Name);
        Require(seen.SetEquals(names), "unexpected JSON keys");
    }

    public static void Run()
    {
        var fixture = Path.Combine(AppContext.BaseDirectory, "portable-i64.v1.json");
        var bytes = File.ReadAllBytes(fixture);
        Require(bytes.Length is > 0 and <= 8192, "empty or oversized fixture");
        var prefix = Encoding.ASCII.GetBytes("blob " + bytes.Length.ToString(
            CultureInfo.InvariantCulture) + "\0");
        var blobBytes = new byte[prefix.Length + bytes.Length];
        Buffer.BlockCopy(prefix, 0, blobBytes, 0, prefix.Length);
        Buffer.BlockCopy(bytes, 0, blobBytes, prefix.Length, bytes.Length);
        var actualBlob = Convert.ToHexString(SHA1.HashData(blobBytes)).ToLowerInvariant();
        Require(actualBlob == ReviewedBlob, "unreviewed Git blob");
        Require(Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() == ReviewedSha256,
            "unreviewed source-i64 SHA-256");

        using var document = JsonDocument.Parse(bytes);
        var root = document.RootElement;
        ExactProperties(root, "schema_version", "status", "scope", "cases");
        Require(root.GetProperty("schema_version").GetString() == "1.0.0", "corpus schema changed");
        Require(root.GetProperty("status").GetString() == "reference-only-not-compiled-execution",
            "unproven fixture asserts execution");
        var cases = root.GetProperty("cases");
        Require(cases.ValueKind == JsonValueKind.Array &&
                cases.GetArrayLength() == ExpectedIds.Length, "fixture case count changed");

        using var directory = new TemporaryDirectory();
        for (int i = 0; i < ExpectedIds.Length; i++)
        {
            var testCase = cases[i];
            ExactProperties(testCase, "id", "expression", "expected");
            var id = testCase.GetProperty("id").GetString();
            Require(id == ExpectedIds[i], "duplicate or reordered case ID");
            var expression = testCase.GetProperty("expression").GetString();
            var expectedText = testCase.GetProperty("expected").GetString();
            Require(!string.IsNullOrWhiteSpace(expression) && expression.Length <= 256, "invalid expression");
            Require(long.TryParse(expectedText, NumberStyles.AllowLeadingSign,
                CultureInfo.InvariantCulture, out var expected), "expected is not signed i64");

            var source = "pub fnc main():int{return " + expression + ";}\n";
            var typed = OresIrLowering.Lower(OresParser.Parse(source));
            var actualIr = OresIrReferenceEvaluator.Evaluate(typed);
            Require(actualIr == expected, "typed IR result mismatch for " + id);

            // Independently verify the emitted CIL, not merely the parser's AST.
            var assemblyPath = Path.Combine(directory.Path, "case-" + i + ".dll");
            CilEmitter.EmitLibrary(typed, assemblyPath);
            using var assembly = AssemblyDefinition.ReadAssembly(assemblyPath);
            var method = assembly.MainModule.Types.Single(t =>
                t.FullName == "Oreslang.Generated.OresProgram").Methods.Single(m => m.Name == "Run");
            var actualCil = CilReferenceEvaluator.Evaluate(method);
            Require(actualCil == expected, "emitted CIL result mismatch for " + id);
        }

        int negativeIndex = 0;
        foreach (var expression in new[]
        {
            "9223372036854775807+1", "-9223372036854775808-1",
            "3037000500*3037000500", "-(-9223372036854775808)"
        })
        {
            var typed = OresIrLowering.Lower(
                OresParser.Parse("pub fnc main():int{return " + expression + ";}"));
            bool irTrapped = false;
            try { _ = OresIrReferenceEvaluator.Evaluate(typed); }
            catch (OverflowException) { irTrapped = true; }
            Require(irTrapped, "typed IR failed to trap overflow: " + expression);

            var negativePath = Path.Combine(directory.Path, "overflow-" + negativeIndex++ + ".dll");
            CilEmitter.EmitLibrary(typed, negativePath);
            using var overflowAssembly = AssemblyDefinition.ReadAssembly(negativePath);
            var overflowMethod = overflowAssembly.MainModule.Types.Single(t =>
                t.FullName == "Oreslang.Generated.OresProgram").Methods.Single(m => m.Name == "Run");
            bool cilTrapped = false;
            try { _ = CilReferenceEvaluator.Evaluate(overflowMethod); }
            catch (OverflowException) { cilTrapped = true; }
            Require(cilTrapped, "emitted CIL failed to trap overflow: " + expression);
        }
        Console.WriteLine("source-i64: seven verified typed-IR and CIL reference cases; four paired overflow denials; no Native AOT assertion");
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "ores-net-i64-" + Guid.NewGuid().ToString("N"));
        public TemporaryDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
