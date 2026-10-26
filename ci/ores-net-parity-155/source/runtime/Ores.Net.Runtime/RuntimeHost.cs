using System.Globalization;

namespace Ores.Net.Runtime;

/// <summary>Statically calls generated CIL; this method is compiled into the Native AOT executable.</summary>
public static class RuntimeHost
{
    public static int Execute(Func<long> entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        try
        {
            Console.Out.WriteLine(entry().ToString(CultureInfo.InvariantCulture));
            return 0;
        }
        catch (OverflowException)
        {
            Console.Error.WriteLine("Oreslang arithmetic overflow");
            return 70;
        }
        catch (DivideByZeroException)
        {
            Console.Error.WriteLine("Oreslang division by zero");
            return 70;
        }
    }
}
