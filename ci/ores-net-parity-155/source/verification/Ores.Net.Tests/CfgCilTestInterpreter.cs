using Mono.Cecil;
using Mono.Cecil.Cil;

// Verification-only interpreter for the bounded CIL subset emitted by
// CfgCilEmitter. This is NOT used by the Native AOT compiler/runtime.
internal static class CfgCilTestInterpreter
{
    public static long Evaluate(MethodDefinition method, int maxSteps = 100_000)
    {
        if (maxSteps <= 0) throw new ArgumentOutOfRangeException(nameof(maxSteps));
        if (!method.HasBody) throw new FormatException("Missing CFG CIL body");

        var instructions = method.Body.Instructions;
        var indexes = new Dictionary<Instruction, int>();
        for (int i = 0; i < instructions.Count; i++)
            indexes.Add(instructions[i], i);

        var locals = new long[method.Body.Variables.Count];
        var stack = new Stack<long>();
        int pc = 0;
        for (int step = 0; step < maxSteps; step++)
        {
            if (pc < 0 || pc >= instructions.Count)
                throw new FormatException("CFG CIL branch escaped method");
            var ins = instructions[pc++];
            switch (ins.OpCode.Code)
            {
                case Code.Nop: break;
                case Code.Ldc_I8: stack.Push((long)ins.Operand); break;
                case Code.Ldc_I4: stack.Push((int)ins.Operand); break;
                case Code.Ldc_I4_S: stack.Push((sbyte)ins.Operand); break;
                case Code.Ldc_I4_M1: stack.Push(-1); break;
                case Code.Ldc_I4_0: stack.Push(0); break;
                case Code.Ldc_I4_1: stack.Push(1); break;
                case Code.Ldc_I4_2: stack.Push(2); break;
                case Code.Ldc_I4_3: stack.Push(3); break;
                case Code.Ldc_I4_4: stack.Push(4); break;
                case Code.Ldc_I4_5: stack.Push(5); break;
                case Code.Ldc_I4_6: stack.Push(6); break;
                case Code.Ldc_I4_7: stack.Push(7); break;
                case Code.Ldc_I4_8: stack.Push(8); break;
                case Code.Ldloc_0: stack.Push(locals[0]); break;
                case Code.Ldloc_1: stack.Push(locals[1]); break;
                case Code.Ldloc_2: stack.Push(locals[2]); break;
                case Code.Ldloc_3: stack.Push(locals[3]); break;
                case Code.Stloc_0: locals[0] = stack.Pop(); break;
                case Code.Stloc_1: locals[1] = stack.Pop(); break;
                case Code.Stloc_2: locals[2] = stack.Pop(); break;
                case Code.Stloc_3: locals[3] = stack.Pop(); break;
                case Code.Ldloc:
                case Code.Ldloc_S:
                    stack.Push(locals[((VariableDefinition)ins.Operand).Index]);
                    break;
                case Code.Stloc:
                case Code.Stloc_S:
                    locals[((VariableDefinition)ins.Operand).Index] = stack.Pop();
                    break;
                case Code.Add_Ovf:
                case Code.Sub_Ovf:
                case Code.Mul_Ovf:
                case Code.Div:
                case Code.Ceq:
                case Code.Clt:
                {
                    long right = stack.Pop();
                    long left = stack.Pop();
                    stack.Push(ins.OpCode.Code switch
                    {
                        Code.Add_Ovf => checked(left + right),
                        Code.Sub_Ovf => checked(left - right),
                        Code.Mul_Ovf => checked(left * right),
                        Code.Div => DivideChecked(left, right),
                        Code.Ceq => left == right ? 1L : 0L,
                        Code.Clt => left < right ? 1L : 0L,
                        _ => throw new FormatException("Unexpected CFG CIL opcode")
                    });
                    break;
                }
                case Code.Br:
                case Code.Br_S:
                    if (stack.Count != 0)
                        throw new FormatException("CFG branch with nonempty stack");
                    pc = indexes[(Instruction)ins.Operand];
                    break;
                case Code.Brtrue:
                case Code.Brtrue_S:
                case Code.Brfalse:
                case Code.Brfalse_S:
                {
                    bool nonzero = stack.Pop() != 0;
                    if (stack.Count != 0)
                        throw new FormatException("CFG conditional branch with nonempty stack");
                    bool take = ins.OpCode.Code is Code.Brtrue or Code.Brtrue_S
                        ? nonzero : !nonzero;
                    if (take) pc = indexes[(Instruction)ins.Operand];
                    break;
                }
                case Code.Ret:
                    if (stack.Count != 1)
                        throw new FormatException("Invalid CIL return stack");
                    return stack.Pop();
                default:
                    throw new FormatException("Unsupported CFG CIL opcode " + ins.OpCode.Code);
            }
            if (stack.Count > method.Body.MaxStackSize)
                throw new FormatException("CFG CIL evaluation stack too deep");
        }
        throw new InvalidOperationException("CFG CIL exceeded finite step budget");
    }

    private static long DivideChecked(long left, long right)
    {
        if (right == 0) throw new DivideByZeroException();
        if (left == long.MinValue && right == -1) throw new OverflowException();
        return left / right;
    }
}
