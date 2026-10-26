using Ores.Net.Compiler;

internal static class OresIrReferenceEvaluator
{
    /// <summary>
    /// Managed verification-only interpreter for the i64 SSA subset.
    /// The released Native AOT compiler does NOT run generated guest code.
    /// </summary>
    public static long Evaluate(VerifiedIrFunction verified)
    {
        ArgumentNullException.ThrowIfNull(verified);
        var values = new long[verified.Instructions.Count];
        foreach (var operation in verified.Instructions)
        {
            long left = operation.Left.HasValue ? values[operation.Left.Value] : 0;
            long right = operation.Right.HasValue ? values[operation.Right.Value] : 0;
            values[operation.ResultId] = operation.Opcode switch
            {
                IrOpcode.ConstantI64 => operation.Constant!.Value,
                IrOpcode.CheckedAdd => checked(left + right),
                IrOpcode.CheckedSubtract => checked(left - right),
                IrOpcode.CheckedMultiply => checked(left * right),
                IrOpcode.CheckedDivide => DivideChecked(left, right),
                _ => throw new FormatException("Unverified IR opcode")
            };
        }
        return values[verified.ReturnId];
    }

    private static long DivideChecked(long left, long right)
    {
        if (right == 0) throw new DivideByZeroException();
        if (left == long.MinValue && right == -1)
            throw new OverflowException("Signed division overflow");
        return left / right;
    }
}
