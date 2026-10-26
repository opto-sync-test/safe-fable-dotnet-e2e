namespace Ores.Net.Compiler;

/// <summary>Explicit value types in the first typed OresIR slice.
/// Future types must be added deliberately, not silently coerced into i64.</summary>
public enum IrValueType
{
    I64,
    Bool
}

public enum IrOpcode
{
    ConstantI64,
    CheckedAdd,
    CheckedSubtract,
    CheckedMultiply,
    CheckedDivide
}

/// <summary>
/// A value definition has exactly one result ID. Operands refer to previously
/// defined IDs; there are no mutable phi/branch edges in the bootstrap subset.
/// </summary>
public sealed record IrInstruction(
    int ResultId,
    IrOpcode Opcode,
    IrValueType Type,
    int? Left = null,
    int? Right = null,
    long? Constant = null);

/// <summary>Untrusted compiler IR. Never lower an IrFunction without verification.</summary>
public sealed record IrFunction(
    string Name,
    IrValueType ResultType,
    IReadOnlyList<IrInstruction> Instructions,
    int ReturnId);

/// <summary>
/// Frozen validated IR, safe from caller mutations to an original instruction
/// list. Construction is only permitted through OresIrVerifier.Verify.
/// </summary>
public sealed class VerifiedIrFunction
{
    internal VerifiedIrFunction(
        string name, IrValueType resultType,
        IReadOnlyList<IrInstruction> instructions, int returnId)
    {
        Name = name;
        ResultType = resultType;
        Instructions = instructions;
        ReturnId = returnId;
    }

    public string Name { get; }
    public IrValueType ResultType { get; }
    public IReadOnlyList<IrInstruction> Instructions { get; }
    public int ReturnId { get; }
}

public static class OresIrVerifier
{
    // .NET CIL backend materializes one i64 local per SSA result.
    // Match its hard bound so 'check' cannot accept a program 'compile' rejects.
    public const int MaxInstructions = 16_384;

    public static VerifiedIrFunction Verify(IrFunction function)
    {
        ArgumentNullException.ThrowIfNull(function);
        if (string.IsNullOrWhiteSpace(function.Name) || function.Name.Length > 128 ||
            !IsIdentifier(function.Name))
            throw new FormatException("Invalid IR function name");
        if (function.ResultType != IrValueType.I64)
            throw new FormatException("Bootstrap IR only supports i64 function results");

        var source = function.Instructions ??
            throw new FormatException("IR instructions must not be null");
        if (source.Count == 0 || source.Count > MaxInstructions)
            throw new FormatException("IR instruction budget exceeded");

        // Snapshot the input list. A caller must not be able to mutate an IR
        // program after verification and before code generation.
        var verified = new IrInstruction[source.Count];
        for (int i = 0; i < source.Count; i++)
        {
            var instruction = source[i] ??
                throw new FormatException("Null IR instruction");
            if (instruction.ResultId != i)
                throw new FormatException("IR must use unique contiguous SSA result IDs");
            if (instruction.Type != IrValueType.I64)
                throw new FormatException("Unsupported IR value type");

            if (instruction.Opcode == IrOpcode.ConstantI64)
            {
                if (!instruction.Constant.HasValue ||
                    instruction.Left.HasValue || instruction.Right.HasValue)
                    throw new FormatException("Malformed IR constant");
            }
            else
            {
                if (instruction.Opcode is not (IrOpcode.CheckedAdd or
                    IrOpcode.CheckedSubtract or IrOpcode.CheckedMultiply or
                    IrOpcode.CheckedDivide))
                    throw new FormatException("Unknown IR opcode");

                if (instruction.Constant.HasValue ||
                    !instruction.Left.HasValue || !instruction.Right.HasValue)
                    throw new FormatException("Malformed IR arithmetic operation");
                if (instruction.Left.Value < 0 || instruction.Left.Value >= i ||
                    instruction.Right.Value < 0 || instruction.Right.Value >= i)
                    throw new FormatException("IR operand must be a prior SSA definition");
                if (verified[instruction.Left.Value].Type != IrValueType.I64 ||
                    verified[instruction.Right.Value].Type != IrValueType.I64)
                    throw new FormatException("IR arithmetic requires i64 operands");
            }
            verified[i] = instruction;
        }

        if (function.ReturnId < 0 || function.ReturnId >= verified.Length ||
            verified[function.ReturnId].Type != function.ResultType)
            throw new FormatException("IR return references missing or incorrect type");

        return new VerifiedIrFunction(function.Name, function.ResultType,
            Array.AsReadOnly(verified), function.ReturnId);
    }

    private static bool IsIdentifier(string value)
    {
        if (!IsAsciiAlpha(value[0]) && value[0] != '_') return false;
        for (int i = 1; i < value.Length; i++)
            if (!IsAsciiAlpha(value[i]) && value[i] != '_' &&
                value[i] is not (>= '0' and <= '9')) return false;
        return true;
    }

    private static bool IsAsciiAlpha(char c) =>
        c is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z');
}

/// <summary>
/// Translates the existing arithmetic parser AST into immutable verified SSA.
/// This is deliberately an independent stage, not yet connected to CIL emission:
/// current release bootstrap behavior must not silently change.
/// </summary>
public static class OresIrLowering
{
    private const int MaxAstNodes = 100_000;
    private const int MaxPendingValues = 256;
    private readonly record struct Pending(Expression Node, bool Finish);

    public static VerifiedIrFunction Lower(Expression root, string name = "main")
    {
        ArgumentNullException.ThrowIfNull(root);
        var pending = new Stack<Pending>();
        var results = new Stack<int>();
        var instructions = new List<IrInstruction>();
        pending.Push(new Pending(root, false));
        int visited = 0;

        int Constant(long value)
        {
            if (instructions.Count >= OresIrVerifier.MaxInstructions)
                throw new FormatException("IR instruction budget exceeded");
            int id = instructions.Count;
            instructions.Add(new IrInstruction(id, IrOpcode.ConstantI64,
                IrValueType.I64, Constant: value));
            return id;
        }

        int EmitBinary(IrOpcode opcode, int left, int right)
        {
            if (instructions.Count >= OresIrVerifier.MaxInstructions)
                throw new FormatException("IR instruction budget exceeded");
            int id = instructions.Count;
            instructions.Add(new IrInstruction(id, opcode,
                IrValueType.I64, Left: left, Right: right));
            return id;
        }

        while (pending.Count > 0)
        {
            var current = pending.Pop();
            var node = current.Node ??
                throw new FormatException("Null AST node");
            if (current.Finish)
            {
                switch (node)
                {
                    case Unary { Operator: '+' }:
                        break;
                    case Unary { Operator: '-' }:
                    {
                        if (results.Count < 1)
                            throw new FormatException("IR lowering operand underflow");
                        int operand = results.Pop();
                        results.Push(EmitBinary(IrOpcode.CheckedSubtract,
                            Constant(0), operand));
                        break;
                    }
                    case Binary binary:
                    {
                        if (results.Count < 2)
                            throw new FormatException("IR lowering operand underflow");
                        int right = results.Pop();
                        int left = results.Pop();
                        var opcode = binary.Operator switch
                        {
                            '+' => IrOpcode.CheckedAdd,
                            '-' => IrOpcode.CheckedSubtract,
                            '*' => IrOpcode.CheckedMultiply,
                            '/' => IrOpcode.CheckedDivide,
                            _ => throw new FormatException("Unsupported arithmetic operator")
                        };
                        results.Push(EmitBinary(opcode, left, right));
                        break;
                    }
                    default:
                        throw new FormatException("Invalid IR lowering finish frame");
                }
            }
            else
            {
                if (++visited > MaxAstNodes)
                    throw new FormatException("IR AST node budget exceeded");
                switch (node)
                {
                    case Literal literal:
                        results.Push(Constant(literal.Value));
                        break;
                    case Unary { Operator: '+' or '-' } unary:
                        pending.Push(new Pending(node, true));
                        pending.Push(new Pending(unary.Value, false));
                        break;
                    case Binary binary when binary.Operator is '+' or '-' or '*' or '/':
                        pending.Push(new Pending(binary, true));
                        pending.Push(new Pending(binary.Right, false));
                        pending.Push(new Pending(binary.Left, false));
                        break;
                    default:
                        throw new FormatException("Unsupported AST node");
                }
            }
            if (results.Count > MaxPendingValues)
                throw new FormatException("IR evaluation stack budget exceeded");
        }
        if (results.Count != 1)
            throw new FormatException("IR lowering must yield exactly one result");
        return OresIrVerifier.Verify(new IrFunction(name, IrValueType.I64,
            instructions, results.Pop()));
    }
}
