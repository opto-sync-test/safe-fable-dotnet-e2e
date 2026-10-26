using Ores.Net.Compiler;

// Managed verification-only CFG interpreter; never shipped by the compiler.
internal static class CfgReferenceEvaluator
{
    public static long Evaluate(VerifiedCfgFunction function, int maxSteps = 100_000)
    {
        ArgumentNullException.ThrowIfNull(function);
        if (maxSteps <= 0) throw new ArgumentOutOfRangeException(nameof(maxSteps));
        var blocks = function.Blocks.ToDictionary(b => b.Name, StringComparer.Ordinal);
        var values = new Dictionary<int, object>();
        string currentName = function.Entry;
        object[] arguments = Array.Empty<object>();

        for (int step = 0; step < maxSteps; step++)
        {
            var block = blocks[currentName];
            if (block.Parameters.Count != arguments.Length)
                throw new InvalidOperationException("Invalid verified block argument arity");
            for (int i = 0; i < arguments.Length; i++)
                values[block.Parameters[i].Id] = arguments[i];

            foreach (var op in block.Instructions)
            {
                long Left() => (long)values[op.Left!.Value];
                long Right() => (long)values[op.Right!.Value];
                values[op.ResultId] = op.Opcode switch
                {
                    CfgOpcode.ConstantI64 => op.I64Constant!.Value,
                    CfgOpcode.ConstantBool => op.BoolConstant!.Value,
                    CfgOpcode.CheckedAdd => checked(Left() + Right()),
                    CfgOpcode.CheckedSubtract => checked(Left() - Right()),
                    CfgOpcode.CheckedMultiply => checked(Left() * Right()),
                    CfgOpcode.CheckedDivide => DivideChecked(Left(), Right()),
                    CfgOpcode.EqualI64 => Left() == Right(),
                    CfgOpcode.LessThanI64 => Left() < Right(),
                    _ => throw new InvalidOperationException("Unexpected CFG opcode")
                };
            }

            switch (block.Terminator)
            {
                case CfgReturn returned:
                    return (long)values[returned.ValueId];
                case CfgJump jump:
                    arguments = jump.Arguments.Select(id => values[id]).ToArray();
                    currentName = jump.Target;
                    break;
                case CfgBranch branch:
                    bool condition = (bool)values[branch.Condition];
                    arguments = (condition ? branch.TrueArguments : branch.FalseArguments)
                        .Select(id => values[id]).ToArray();
                    currentName = condition ? branch.TrueTarget : branch.FalseTarget;
                    break;
                default:
                    throw new InvalidOperationException("Unexpected CFG terminator");
            }
        }

        throw new InvalidOperationException("CFG execution exceeded finite step budget");
    }

    private static long DivideChecked(long left, long right)
    {
        if (right == 0) throw new DivideByZeroException();
        if (left == long.MinValue && right == -1) throw new OverflowException();
        return left / right;
    }
}
