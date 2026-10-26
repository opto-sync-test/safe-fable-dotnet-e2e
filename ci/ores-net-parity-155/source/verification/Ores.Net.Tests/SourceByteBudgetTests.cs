using System.Text;
using Ores.Net.Compiler;

internal static class SourceByteBudgetTests
{
    public static void Run()
    {
        const int limit = 1_048_576;
        const string prefix = "fnc main(): int { return 1; } //";
        foreach (string scalar in new[] { "é", "€", "😀" })
        {
            int remaining = limit - Encoding.UTF8.GetByteCount(prefix);
            int width = Encoding.UTF8.GetByteCount(scalar);
            string exact = prefix + string.Concat(Enumerable.Repeat(scalar, remaining / width))
                + new string(' ', remaining % width);
            if (Encoding.UTF8.GetByteCount(exact) != limit)
                throw new Exception("Invalid source-byte boundary fixture");
            _ = OresParser.Parse(exact);
            _ = OresStructuredParser.Parse(exact);
            foreach (Action parse in new Action[] {
                () => OresParser.Parse(exact + scalar),
                () => OresStructuredParser.Parse(exact + scalar) })
            {
                try { parse(); }
                catch (FormatException ex) when (ex.Message.Contains("1 MiB")) { continue; }
                throw new Exception("Multibyte source exceeded byte limit without admission failure");
            }
        }
    }
}
