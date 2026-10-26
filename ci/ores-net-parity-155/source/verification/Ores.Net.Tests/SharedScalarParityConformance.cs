using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Mono.Cecil;
using Ores.Net.Compiler;

internal static class SharedScalarParityConformance
{
    private const string ExpectedSuiteSha256 =
        "5b5d1bc00def9b3a343cb3281e0bb0be4e5ca438095f621141049e2d7a1a25b3";

    private static void Require(bool valid, string message)
    {
        if (!valid) throw new InvalidOperationException("shared scalar parity: " + message);
    }

    public static void Run()
    {
        var root = Path.Combine(AppContext.BaseDirectory, "contracts", "scalar", "v1");
        var manifestPath = Path.Combine(root, "cases.json");
        var manifestBytes = File.ReadAllBytes(manifestPath);
        Require(manifestBytes.Length is > 0 and <= 65536, "invalid manifest size");

        using var document = JsonDocument.Parse(manifestBytes);
        var corpus = document.RootElement;
        Require(corpus.GetProperty("schema_version").GetString() == "1.0.0",
            "schema version drift");
        var cases = corpus.GetProperty("cases");
        Require(cases.ValueKind == JsonValueKind.Array && cases.GetArrayLength() == 11,
            "case inventory drift");

        using var suiteHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        suiteHash.AppendData(manifestBytes);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var accepts = 0;
        var rejects = 0;
        using var temp = new TemporaryDirectory();

        foreach (var testCase in cases.EnumerateArray())
        {
            var id = testCase.GetProperty("id").GetString() ?? "";
            var file = testCase.GetProperty("file").GetString() ?? "";
            var kind = testCase.GetProperty("kind").GetString() ?? "";
            Require(System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-z][a-z0-9.-]{1,79}$"),
                "unsafe case id");
            Require(seen.Add(id), "duplicate case id: " + id);
            Require(System.Text.RegularExpressions.Regex.IsMatch(file,
                "^fixtures/[a-z0-9-]+\\.ores$"), "unsafe fixture path: " + file);

            var fixturePath = Path.Combine(root, file.Replace('/', Path.DirectorySeparatorChar));
            var sourceBytes = File.ReadAllBytes(fixturePath);
            Require(sourceBytes.Length is > 0 and <= 1048576, "invalid fixture size: " + file);
            suiteHash.AppendData(Encoding.ASCII.GetBytes(file));
            suiteHash.AppendData(new byte[] { 0 });
            suiteHash.AppendData(sourceBytes);
            var source = new UTF8Encoding(false, true).GetString(sourceBytes);

            if (kind == "accept")
            {
                accepts++;
                var expectedText = testCase.GetProperty("value").GetString();
                Require(long.TryParse(expectedText, NumberStyles.AllowLeadingSign,
                    CultureInfo.InvariantCulture, out var expected), "invalid expected i64: " + id);
                var typed = OresIrLowering.Lower(OresParser.Parse(source));
                Require(OresIrReferenceEvaluator.Evaluate(typed) == expected,
                    "typed IR result mismatch: " + id);

                var assemblyPath = Path.Combine(temp.Path, id.Replace('.', '-') + ".dll");
                CilEmitter.EmitLibrary(typed, assemblyPath);
                using var assembly = AssemblyDefinition.ReadAssembly(assemblyPath);
                var method = assembly.MainModule.Types.Single(t =>
                    t.FullName == "Oreslang.Generated.OresProgram").Methods.Single(m => m.Name == "Run");
                Require(CilReferenceEvaluator.Evaluate(method) == expected,
                    "emitted CIL result mismatch: " + id);
                continue;
            }

            Require(kind == "reject", "unknown case kind: " + kind);
            rejects++;
            try
            {
                _ = OresParser.Parse(source);
                throw new InvalidOperationException("shared scalar parity: rejected fixture admitted: " + id);
            }
            catch (FormatException)
            {
                // Expected: the bootstrap compiler must fail closed on all shared negatives.
            }
        }

        Require(accepts == 6 && rejects == 5, "accept/reject counts changed");
        var suite = Convert.ToHexString(suiteHash.GetHashAndReset()).ToLowerInvariant();
        Require(suite == ExpectedSuiteSha256, "suite SHA-256 differs from Wasm/JS contract");
        Console.WriteLine("shared scalar parity: 6 accepts + 5 denials; suite " + suite);
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "ores-net-shared-scalar-" + Guid.NewGuid().ToString("N"));

        public TemporaryDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
