using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Ores.Net.Compiler;

/// <summary>
/// Restricted, advisory ores-static-facts/v0 producer. These facts are neither
/// an attested compiler certificate nor a proof of termination, WCET, zero GC,
/// Native AOT safety, callback ordering, or actor isolation.
/// </summary>
public static class StaticFactsV0Exporter
{
    private const int MaxProcedures = 512;
    private const int MaxLoopsPerProcedure = 256;
    private const int MaxTotalLoops = 4_096;
    private const int MaxCallEdges = 8_192;
    private const int MaxAstDepth = 128;
    private const int MaxVisitedNodes = 32_768;

    /// <summary>
    /// Production compiler path: the same signed-i64 parser and frozen, verified
    /// SSA OresIR used by oresnet check/compile. Calls/loops cannot enter it.
    /// </summary>
    public static string FromCompiledScalarSource(string source)
    {
        ValidateSource(source);
        var expression = OresParser.Parse(source);
        VerifiedIrFunction function = OresIrLowering.Lower(expression);
        if (function.Name != "main" || function.ResultType != IrValueType.I64 ||
            function.Instructions.Count == 0)
            throw Unsupported("non-main or unverified scalar function");
        return WriteFacts(source, Array.Empty<string>());
    }

    /// <summary>
    /// Experimental typed structured *parser* path, not shipping codegen.
    /// It recognizes single-main scalar locals, if/else and while, with every
    /// loop marked unknown; no interprocedural or actor effects are admitted.
    /// </summary>
    public static string FromStructuredSource(string source)
    {
        ValidateSource(source);
        StructuredProgram program = OresStructuredParser.Parse(source);
        if (program.Name != "main") throw Unsupported("non-main structured program");
        var visitor = new StructuredVisitor();
        visitor.Statements(program.Body, 1);
        return WriteFacts(source, visitor.LoopIds);
    }

    private static void ValidateSource(string source)
    {
        ArgumentNullException.ThrowIfNull(source);
        if (source.Length > 1_048_576 || Encoding.UTF8.GetByteCount(source) > 1_048_576)
            throw Unsupported("source exceeds the 1 MiB scalar bridge limit");
        if (source.Length > 0 && source[0] == '\uFEFF')
            throw Unsupported("BOM cannot be silently erased from source identity");
        if (source.Contains('\0'))
            throw Unsupported("NUL bytes cannot be admitted");
        // The lexer rejects malformed Unicode; prevent a replacement fallback
        // from signing different bytes from those originally read.
        for (int i = 0; i < source.Length; i++)
        {
            if (char.IsHighSurrogate(source[i]))
            {
                if (++i >= source.Length || !char.IsLowSurrogate(source[i]))
                    throw Unsupported("invalid Unicode scalar");
            }
            else if (char.IsLowSurrogate(source[i]))
                throw Unsupported("invalid Unicode scalar");
        }
    }

    private static string WriteFacts(string source, IReadOnlyList<string> loops)
    {
        if (MaxProcedures < 1 || MaxCallEdges < 0 ||
            loops.Count > MaxLoopsPerProcedure || loops.Count > MaxTotalLoops)
            throw Unsupported("static-facts graph exceeds downstream analysis budget");

        // UTF8 bytes are exactly the input source bytes. The digest is an
        // identity only; an attacker can forge an unsigned JSON file.
        string digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source)))
            .ToLowerInvariant();
        using var stream = new MemoryStream();
        using (var json = new Utf8JsonWriter(stream))
        {
            json.WriteStartObject();
            json.WriteString("version", "ores-static-facts/v0");
            json.WriteString("unit", "sha256:" + digest);
            json.WriteStartArray("procedures");
            json.WriteStartObject();
            json.WriteString("id", "__root__.main/0");
            json.WriteStartArray("loops");
            foreach (string id in loops)
            {
                json.WriteStartObject();
                json.WriteString("id", id);
                json.WriteString("exit", "unknown");
                json.WriteBoolean("safepoint", false);
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteEndObject();
            json.WriteEndArray();
            foreach (string key in new[] { "edges", "taint_sources", "flows", "sinks", "permission_checks" })
            {
                json.WriteStartArray(key);
                json.WriteEndArray();
            }
            json.WriteEndObject();
            json.Flush();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static FormatException Unsupported(string feature) =>
        new("ORES-ANALYZE-UNSUPPORTED: " + feature +
            " has no verified .NET static-facts/v0 effect lowering");

    private sealed class StructuredVisitor
    {
        private int visitedNodes;
        internal List<string> LoopIds { get; } = new();

        private void Budget(int depth)
        {
            if (depth > MaxAstDepth || ++visitedNodes > MaxVisitedNodes)
                throw Unsupported("structured AST recursion/work budget exceeded");
        }

        internal void Statements(IReadOnlyList<StructuredStmt> statements, int depth)
        {
            ArgumentNullException.ThrowIfNull(statements);
            Budget(depth);
            if (statements.Count > MaxVisitedNodes)
                throw Unsupported("structured statement collection exceeds analysis budget");
            foreach (var stmt in statements)
            {
                Budget(depth);
                switch (stmt)
                {
                    case StructuredLet l:
                        Expression(l.Initializer, depth + 1);
                        break;
                    case StructuredSet s:
                        Expression(s.Value, depth + 1);
                        break;
                    case StructuredReturn r:
                        Expression(r.Value, depth + 1);
                        break;
                    case StructuredIf choice:
                        Expression(choice.Condition, depth + 1);
                        Statements(choice.Then, depth + 1);
                        if (choice.Else is not null) Statements(choice.Else, depth + 1);
                        break;
                    case StructuredWhile loop:
                        if (LoopIds.Count >= MaxLoopsPerProcedure ||
                            LoopIds.Count >= MaxTotalLoops)
                            throw Unsupported("too many loops for shared analyzer importer");
                        LoopIds.Add("L" + (LoopIds.Count + 1));
                        Expression(loop.Condition, depth + 1);
                        Statements(loop.Body, depth + 1);
                        break;
                    default:
                        throw Unsupported("unrecognized structured statement");
                }
            }
        }

        private void Expression(StructuredExpr expression, int depth)
        {
            ArgumentNullException.ThrowIfNull(expression);
            Budget(depth);
            switch (expression)
            {
                case StructuredInt:
                case StructuredBool:
                case StructuredRead:
                    return;
                case StructuredNegate neg:
                    Expression(neg.Value, depth + 1);
                    return;
                case StructuredBinary binary:
                    Expression(binary.Left, depth + 1);
                    Expression(binary.Right, depth + 1);
                    return;
                default:
                    throw Unsupported("unrecognized structured expression");
            }
        }
    }
}
