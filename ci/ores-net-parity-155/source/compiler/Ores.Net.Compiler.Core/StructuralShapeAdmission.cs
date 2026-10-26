namespace Ores.Net.Compiler;

/// <summary>
/// Conservative, source-only admission guard for structural match patterns.
/// The scalar CIL bootstrap has no typed shape metadata, readonly view loans
/// or runtime structural dispatch. A pattern must fail before OresIR/CIL.
/// This is NOT a positive structural type checker.
/// </summary>
public static class StructuralShapeAdmission
{
    public static void RejectUnsupportedPatterns(string source)
    {
        ArgumentNullException.ThrowIfNull(source);
        bool afterOn = false;
        for (int i = 0; i < source.Length;)
        {
            char c = source[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == '/' && i + 1 < source.Length && source[i + 1] == '/')
            {
                i += 2;
                while (i < source.Length && source[i] != '\n') i++;
                continue;
            }
            if (c == '/' && i + 1 < source.Length && source[i + 1] == '*')
            {
                int start = i;
                i += 2;
                int depth = 1;
                while (i < source.Length && depth > 0)
                {
                    if (source[i] == '/' && i + 1 < source.Length && source[i + 1] == '*')
                    {
                        if (++depth > 64)
                            throw new FormatException($"Structural admission comment nesting exceeded at offset {i}");
                        i += 2;
                    }
                    else if (source[i] == '*' && i + 1 < source.Length && source[i + 1] == '/')
                    {
                        depth--;
                        i += 2;
                    }
                    else i++;
                }
                if (depth != 0)
                    throw new FormatException($"Unterminated block comment at offset {start}");
                continue;
            }
            if (c is '"' or '\'')
            {
                int start = i++;
                bool closed = false;
                while (i < source.Length)
                {
                    char x = source[i++];
                    if (x == '\\' && i < source.Length) { i++; continue; }
                    if (x == c) { closed = true; break; }
                }
                if (!closed) throw new FormatException($"Unterminated source string at offset {start}");
                afterOn = false;
                continue;
            }
            if (char.IsAsciiLetter(c) || c == '_')
            {
                int start = i++;
                while (i < source.Length &&
                       (char.IsAsciiLetterOrDigit(source[i]) || source[i] == '_')) i++;
                var word = source[start..i];
                if (afterOn && word == "structural")
                    throw new FormatException($"Structural match pattern unsupported in scalar CIL at offset {start}");
                afterOn = word == "on";
                continue;
            }
            afterOn = false;
            i++;
        }
    }
}
