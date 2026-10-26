namespace Ores.Net.Compiler;

/// <summary>
/// Look ahead only through lexical trivia when checking the contextual
/// `task { ... }` safety gate. The word `task` remains legal as a normal
/// identifier without a following Task body.
///
/// This does not enable Task syntax; it prevents comments from hiding an
/// unsupported independently scheduled execution boundary.
/// </summary>
internal static class ContextualTaskBoundary
{
    internal static bool OpensBlock(string source, int index)
    {
        while (index < source.Length)
        {
            if (char.IsWhiteSpace(source[index]))
            {
                index++;
                continue;
            }
            if (source[index] == '/' && index + 1 < source.Length
                && source[index + 1] == '/')
            {
                index += 2;
                while (index < source.Length && source[index] != '\n')
                    index++;
                continue;
            }
            if (source[index] == '/' && index + 1 < source.Length
                && source[index + 1] == '*')
            {
                index += 2;
                int depth = 1;
                while (depth > 0)
                {
                    if (index >= source.Length)
                        throw new FormatException("unterminated block comment after task");
                    if (index + 1 < source.Length && source[index] == '/'
                        && source[index + 1] == '*')
                    {
                        if (++depth > 128)
                            throw new FormatException("block comment nesting exceeds 128");
                        index += 2;
                    }
                    else if (index + 1 < source.Length && source[index] == '*'
                             && source[index + 1] == '/')
                    {
                        depth--;
                        index += 2;
                    }
                    else index++;
                }
                continue;
            }
            return source[index] == '{';
        }
        return false;
    }
}
