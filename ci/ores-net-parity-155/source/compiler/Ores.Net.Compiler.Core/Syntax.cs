using System.Globalization;

namespace Ores.Net.Compiler;

public abstract record Expression;
public sealed record Literal(long Value) : Expression;
public sealed record Unary(char Operator, Expression Value) : Expression;
public sealed record Binary(char Operator, Expression Left, Expression Right) : Expression;

public static class OresParser
{
    private const int MaxDepth = 128;
    private const int MaxTokens = 100_000;

    public static Expression Parse(string source)
    {
        ArgumentNullException.ThrowIfNull(source);
        if (source.Length > 1_048_576)
            throw new FormatException("Source is larger than the 1 MiB bootstrap limit");
        for (int i = 0; i < source.Length; i++)
        {
            char c = source[i];
            if (c == '\0') throw new FormatException("Source contains NUL byte");
            if (char.IsHighSurrogate(c))
            {
                if (++i >= source.Length || !char.IsLowSurrogate(source[i]))
                    throw new FormatException("Source contains invalid UTF-16");
            }
            else if (char.IsLowSurrogate(c))
                throw new FormatException("Source contains invalid UTF-16");
        }
        // Public parser callers supply UTF-16 strings; the source budget is
        // UTF-8 bytes, matching the disk/CLI boundary, not code-unit count.
        if (System.Text.Encoding.UTF8.GetByteCount(source) > 1_048_576)
            throw new FormatException("Source exceeds 1 MiB UTF-8 parser limit");
        // No structural match lowering or readonly shape metadata in scalar CIL yet.
        StructuralShapeAdmission.RejectUnsupportedPatterns(source);
        var lexer = new Lexer(source);
        var tokens = new List<Token>();
        for (;;)
        {
            var token = lexer.Read();
            tokens.Add(token);
            if (tokens.Count > MaxTokens)
                throw new FormatException("Token count exceeds bootstrap limit");
            if (token.Text.Length == 0) break;
        }
        return new Reader(tokens).ParseProgram();
    }

    private readonly record struct Token(string Text, int Offset);

    private sealed class Lexer(string text)
    {
        private int _i;

        public Token Read()
        {
            while (_i < text.Length)
            {
                if (char.IsWhiteSpace(text[_i])) { _i++; continue; }
                if (text[_i] == '/' && _i + 1 < text.Length && text[_i + 1] == '/')
                {
                    _i += 2;
                    while (_i < text.Length && text[_i] is not ('\n' or '\r' or '\u0085' or '\u2028' or '\u2029')) _i++;
                    continue;
                }
                // Keep comments lexically invisible even when they occur
                // between a tagged namespace and '.' in a rejected pipeline.
                if (text[_i] == '/' && _i + 1 < text.Length && text[_i + 1] == '*')
                {
                    var offset = _i;
                    _i += 2;
                    var depth = 1;
                    while (depth > 0)
                    {
                        if (_i == text.Length)
                            throw new FormatException($"Unterminated block comment at offset {offset}");
                        if (_i + 1 < text.Length && text[_i] == '/' && text[_i + 1] == '*')
                        {
                            if (++depth > 128)
                                throw new FormatException($"Block comment nesting exceeds 128 at offset {offset}");
                            _i += 2;
                        }
                        else if (_i + 1 < text.Length && text[_i] == '*' && text[_i + 1] == '/')
                        {
                            depth--;
                            _i += 2;
                        }
                        else _i++;
                    }
                    continue;
                }
                break;
            }
            var start = _i;
            if (_i == text.Length) return new Token("", start);
            var ch = text[_i];
            if (ch is >= '0' and <= '9')
            {
                // Match the reference's decimal digit separators without
                // admitting trailing, adjacent or non-digit underscores.
                // Only ASCII decimal digits are accepted, never host-culture
                // separators or floating-point literals.
                _i++;
                while (_i < text.Length)
                {
                    if (text[_i] is >= '0' and <= '9') { _i++; continue; }
                    if (text[_i] != '_') break;
                    if (_i + 1 >= text.Length ||
                        text[_i + 1] is not (>= '0' and <= '9'))
                        throw new FormatException($"Invalid i64 digit separator at offset {_i}");
                    _i++;
                }
                // The bootstrap compiler is i64-only. Reject Java-compatible
                // real-literal starts before splitting into integer tokens.
                if (_i < text.Length &&
                    ((text[_i] == '.' && _i + 1 < text.Length && text[_i + 1] is >= '0' and <= '9') ||
                     ((text[_i] == 'e' || text[_i] == 'E') && _i + 1 < text.Length &&
                       (text[_i + 1] is >= '0' and <= '9' ||
                        ((text[_i + 1] == '+' || text[_i + 1] == '-') &&
                          _i + 2 < text.Length && text[_i + 2] is >= '0' and <= '9'))) ||
                     (text[_i] == 'd' && (_i + 1 == text.Length ||
                         !(char.IsLetterOrDigit(text[_i + 1]) || text[_i + 1] == '_')))))
                    throw new FormatException($"Floating-point/decimal literal requires typed numeric lowering at offset {start}");
                return new Token(text[start.._i], start);
            }
            if (ch is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or '_')
            {
                _i++;
                while (_i < text.Length &&
                    (text[_i] is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '_'))
                    _i++;
                var word = text[start.._i];
                if (word is "any" or "unknown" or "Any" or "Unknown")
                    throw new FormatException(
                        "any/unknown requires tagged opaque-value ABI and Native AOT runtime descriptors");
                // This bootstrap compiler is single-file. Do not accept Java
                // project-root, zed package or bare import declarations until
                // a verified source graph / native AOT linker exists.
                if (word == "import")
                    throw new FormatException("source imports require verified module graph lowering");
                if (word is "cpu" or "gpu" or "nb")
                    throw new FormatException(
                        $"execution region '{word}' requires verified CPU/GPU Task lowering; no implicit CPU fallback at offset {start}");
                if (word == "task")
                {
                    if (ContextualTaskBoundary.OpensBlock(text, _i))
                        throw new FormatException(
                            $"execution task requires scheduler-aware Future/continuation lowering; no implicit inline execution at offset {start}");
                }
                if (word == "enum")
                    throw new FormatException(
                        $"nominal enum overloads require compiler-bound dispatch (unsupported .NET bootstrap) at offset {start}");
                return new Token(word, start);
            }
            // Recognize the contiguous operator as one token, but never
            // attempt a scalar-only approximation of named-call lowering.
            if (ch == '|' && _i + 1 < text.Length && text[_i + 1] == '>')
            {
                _i += 2;
                return new Token("|>", start);
            }
            if (ch == '-' && _i + 1 < text.Length && text[_i + 1] == '>')
            {
                _i += 2;
                return new Token("->", start);
            }
            // Lex assignment punctuation so unsupported declarations are rejected
            // at their declaration, rather than at a later initializer. The
            // arithmetic parser still has no assignment production.
            if ("()+-*/{}:;.=?".IndexOf(ch) >= 0)
            {
                _i++;
                return new Token(text[start.._i], start);
            }
            throw new FormatException($"Invalid character at offset {start}");
        }
    }

    private sealed class Reader(List<Token> tokens)
    {
        private int _index;
        private Token Current => tokens[_index];

        private bool Take(string value)
        {
            if (Current.Text != value) return false;
            _index++;
            return true;
        }

        private void Expect(string value)
        {
            if (!Take(value))
                throw new FormatException($"Expected '{value}' at offset {Current.Offset}");
        }

        public Expression ParseProgram()
        {
            bool defined = false, exposed = false;
            while (Current.Text is "define" or "pub")
            {
                if (Take("define"))
                {
                    if (defined) throw new FormatException("Duplicate define modifier");
                    defined = true;
                }
                else
                {
                    Expect("pub");
                    if (exposed) throw new FormatException("Duplicate pub modifier");
                    exposed = true;
                }
            }
            Expect("fnc");
            Expect("main");
            Expect("(");
            Expect(")");
            if (!Take(":")) Expect("->");
            Expect("int");
            Expect("{");
            Expect("return");
            var expression = ParseAdd(0);
            Expect(";");
            Expect("}");
            if (Current.Text.Length != 0)
                throw new FormatException($"Unexpected token at offset {Current.Offset}");
            return expression;
        }

        private Expression ParseAdd(int depth)
        {
            CheckDepth(depth);
            Expression left = ParseMul(depth + 1);
            while (Current.Text is "+" or "-")
            {
                char op = Current.Text[0];
                _index++;
                left = new Binary(op, left, ParseMul(depth + 1));
            }
            if (Current.Text == "|>")
                throw new FormatException(
                    $"Value pipeline requires named callable lowering; unsupported in .NET i64 bootstrap at offset {Current.Offset}");
            if (Current.Text == "?")
                throw new FormatException(
                    $"Ternary expression requires bool typing and CFG branch-merge lowering in .NET Native AOT backend at offset {Current.Offset}");
            return left;
        }

        private Expression ParseMul(int depth)
        {
            CheckDepth(depth);
            Expression left = ParseUnary(depth + 1);
            while (Current.Text is "*" or "/")
            {
                char op = Current.Text[0];
                // Reference Oreslang int/int has a float result. This i64-only
                // frontend must not silently truncate it using CIL div.
                if (op == '/')
                    throw new FormatException("Division requires float result lowering; unsupported in the i64 source subset");
                _index++;
                left = new Binary(op, left, ParseUnary(depth + 1));
            }
            return left;
        }

        private Expression ParseUnary(int depth)
        {
            CheckDepth(depth);
            if (Current.Text == "rt")
            {
                int at = Current.Offset;
                _index++;
                string operation = Current.Text;
                if (operation is "ref" or "unref" or "deref" or "raw")
                    throw new FormatException(
                        $"Pointer-style operation 'rt {operation}' is not valid Oreslang source; use rt copy/share/take/borrow or rt mut borrow; unsupported in the .NET scalar backend at offset {at}");

                string ownership = operation;
                if (operation == "mut" && _index + 1 < tokens.Count &&
                    tokens[_index + 1].Text == "borrow")
                    ownership = "mut borrow";
                if (operation == "borrow" && _index + 1 < tokens.Count &&
                    tokens[_index + 1].Text == "mut")
                    throw new FormatException(
                        $"Legacy ownership spelling 'rt borrow mut' is rejected; use 'rt mut borrow' at offset {at}");
                if (ownership is "copy" or "share" or "take" or "borrow" or "mut borrow")
                    throw new FormatException(
                        $"Ownership operation 'rt {ownership}' requires typed actor-arena lowering; unsupported in the .NET scalar backend at offset {at}");

                throw new FormatException(
                    $"Runtime ownership operation requires typed lowering; unsupported in the .NET scalar backend at offset {at}");
            }
            if (Take("+")) return new Unary('+', ParseUnary(depth + 1));
            if (Take("-"))
            {
                // Signed minimum needs special treatment: its magnitude is > long.MaxValue.
                if (Current.Text.Replace("_", "", StringComparison.Ordinal).TrimStart('0') == "9223372036854775808")
                {
                    _index++;
                    return new Literal(long.MinValue);
                }
                return new Unary('-', ParseUnary(depth + 1));
            }
            if (Take("("))
            {
                var inner = ParseAdd(depth + 1);
                Expect(")");
                return inner;
            }
            if (Current.Text.Length == 0 || Current.Text[0] is < '0' or > '9')
                throw new FormatException($"Expected integer at offset {Current.Offset}");
            var raw = Current.Text;
            _index++;
            if (!long.TryParse(raw.Replace("_", "", StringComparison.Ordinal),
                NumberStyles.None, CultureInfo.InvariantCulture, out long result))
                throw new FormatException($"Invalid i64 at offset {tokens[_index - 1].Offset}");
            return new Literal(result);
        }

        private static void CheckDepth(int depth)
        {
            if (depth > MaxDepth) throw new FormatException("Expression nesting too deep");
        }
    }
}
