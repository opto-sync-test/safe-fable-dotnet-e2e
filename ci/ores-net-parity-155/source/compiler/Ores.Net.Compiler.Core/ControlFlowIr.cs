namespace Ores.Net.Compiler;

// This CFG IR is deliberately separate from the current straight-line i64
// code generator. It is verified but NOT executable or accepted by oresnet.
public enum CfgOpcode
{
    ConstantI64,
    ConstantBool,
    CheckedAdd,
    CheckedSubtract,
    CheckedMultiply,
    CheckedDivide,
    EqualI64,
    LessThanI64
}

public readonly record struct CfgParameter(int Id, IrValueType Type);

public sealed record CfgInstruction(
    int ResultId, CfgOpcode Opcode, IrValueType Type,
    int? Left = null, int? Right = null,
    long? I64Constant = null, bool? BoolConstant = null);

public abstract record CfgTerminator;
public sealed record CfgReturn(int ValueId) : CfgTerminator;
public sealed record CfgJump(string Target, IReadOnlyList<int> Arguments) : CfgTerminator;
public sealed record CfgBranch(
    int Condition,
    string TrueTarget, IReadOnlyList<int> TrueArguments,
    string FalseTarget, IReadOnlyList<int> FalseArguments) : CfgTerminator;

public sealed record CfgBlock(
    string Name, IReadOnlyList<CfgParameter> Parameters,
    IReadOnlyList<CfgInstruction> Instructions, CfgTerminator Terminator);

public sealed record CfgFunction(
    string Name, IrValueType ResultType, string Entry,
    IReadOnlyList<CfgBlock> Blocks);

public sealed class VerifiedCfgFunction
{
    internal VerifiedCfgFunction(string name, IrValueType resultType,
        string entry, IReadOnlyList<CfgBlock> blocks)
    {
        Name = name;
        ResultType = resultType;
        Entry = entry;
        Blocks = blocks;
    }

    public string Name { get; }
    public IrValueType ResultType { get; }
    public string Entry { get; }
    public IReadOnlyList<CfgBlock> Blocks { get; }
}

/// <summary>
/// Fail-closed structural and SSA verifier for the first control-flow IR.
/// Blocks can loop by passing typed block parameters on each control-flow edge;
/// no unchecked phi instructions or implicit fallthrough are allowed.
/// </summary>
public static class OresCfgVerifier
{
    public const int MaxBlocks = 128;
    public const int MaxValues = OresIrVerifier.MaxInstructions;
    // Edge payloads are not SSA definitions, so they need a separate global
    // bound before copying any untrusted list into the immutable proof.
    public const int MaxEdgeArguments = 2 * MaxValues;

    private readonly record struct Definition(int Block, int Instruction, IrValueType Type);

    public static VerifiedCfgFunction Verify(CfgFunction function)
    {
        ArgumentNullException.ThrowIfNull(function);
        if (!Identifier(function.Name) || function.ResultType != IrValueType.I64 ||
            !Identifier(function.Entry))
            throw new FormatException("Invalid CFG function signature");

        var sourceBlocks = function.Blocks ??
            throw new FormatException("Missing CFG blocks");
        int blockCount = sourceBlocks.Count;
        if (blockCount <= 0 || blockCount > MaxBlocks)
            throw new FormatException("Invalid CFG block count");

        // Deep-copy every caller-provided collection BEFORE analyzing it.
        // A verified CFG cannot be changed through an alias to input lists.
        var blocks = new CfgBlock[blockCount];
        long totalDefinitions = 0;
        long totalEdgeArguments = 0;

        IReadOnlyList<int> FreezeArguments(IReadOnlyList<int>? arguments)
        {
            if (arguments is null)
                throw new FormatException("Missing CFG edge arguments");
            // Check before ToArray: a single malicious edge can otherwise
            // allocate far beyond the i64 SSA/local resource limit.
            int count = arguments.Count;
            if (count < 0 || count > MaxValues ||
                totalEdgeArguments + count > MaxEdgeArguments)
                throw new FormatException("CFG edge argument budget exceeded");
            totalEdgeArguments += count;
            // IReadOnlyList.Count does not constrain IEnumerable enumeration.
            // Copy the admitted number of elements by index, never via
            // LINQ ToArray (which can enumerate unbounded custom inputs).
            return CopyIndexed(arguments, count);
        }

        for (int i = 0; i < blocks.Length; i++)
        {
            var original = sourceBlocks[i] ??
                throw new FormatException("Null CFG block");
            if (!Identifier(original.Name))
                throw new FormatException("Invalid CFG block name");
            var parameters = original.Parameters ??
                throw new FormatException("Missing CFG block parameters");
            var instructions = original.Instructions ??
                throw new FormatException("Missing CFG block instructions");
            var terminator = original.Terminator ??
                throw new FormatException("Missing CFG terminator");
            // Capture each caller-controlled Count exactly once. Re-reading
            // a mutable/adversarial Count after admission could bypass the
            // budget when allocating the snapshot.
            int parameterCount = parameters.Count;
            int instructionCount = instructions.Count;
            if (parameterCount < 0 || instructionCount < 0 ||
                totalDefinitions + parameterCount + (long)instructionCount > MaxValues)
                throw new FormatException("CFG SSA value budget exceeded");
            totalDefinitions += parameterCount + (long)instructionCount;
            CfgTerminator frozenTerminator = terminator switch
            {
                CfgReturn r => new CfgReturn(r.ValueId),
                CfgJump j => new CfgJump(j.Target, FreezeArguments(j.Arguments)),
                CfgBranch c => new CfgBranch(c.Condition, c.TrueTarget,
                    FreezeArguments(c.TrueArguments),
                    c.FalseTarget, FreezeArguments(c.FalseArguments)),
                _ => throw new FormatException("Unsupported CFG terminator")
            };
            blocks[i] = new CfgBlock(original.Name,
                CopyIndexed(parameters, parameterCount),
                CopyIndexed(instructions, instructionCount),
                frozenTerminator);
        }

        var indexes = new Dictionary<string, int>(StringComparer.Ordinal);
        for (int i = 0; i < blocks.Length; i++)
            if (!indexes.TryAdd(blocks[i].Name, i))
                throw new FormatException("Duplicate CFG block");
        if (!indexes.TryGetValue(function.Entry, out int entry))
            throw new FormatException("CFG entry block not found");
        if (blocks[entry].Parameters.Count != 0)
            throw new FormatException("CFG entry block cannot require arguments");

        var definitions = new Dictionary<int, Definition>();
        foreach (var (block, blockIndex) in blocks.Select((b, i) => (b, i)))
        {
            foreach (var parameter in block.Parameters)
                AddDefinition(parameter.Id, parameter.Type, blockIndex, -1);
            for (int instructionIndex = 0; instructionIndex < block.Instructions.Count;
                instructionIndex++)
            {
                var op = block.Instructions[instructionIndex] ??
                    throw new FormatException("Null CFG instruction");
                AddDefinition(op.ResultId, op.Type, blockIndex, instructionIndex);
            }
        }
        if (definitions.Count == 0 || definitions.Count > MaxValues)
            throw new FormatException("CFG SSA value budget exceeded");
        // Dense IDs prevent accidental giant lookup allocations during later
        // local-register assignment, and reject gaps and negative definitions.
        for (int i = 0; i < definitions.Count; i++)
            if (!definitions.ContainsKey(i))
                throw new FormatException("CFG SSA IDs must be dense");

        var successors = new List<int>[blocks.Length];
        var predecessors = new List<int>[blocks.Length];
        for (int i = 0; i < blocks.Length; i++)
        {
            successors[i] = new List<int>();
            predecessors[i] = new List<int>();
        }

        for (int i = 0; i < blocks.Length; i++)
        {
            var block = blocks[i];
            switch (block.Terminator)
            {
                case CfgReturn: break;
                case CfgJump jump:
                    RegisterEdge(i, jump.Target, jump.Arguments);
                    break;
                case CfgBranch branch:
                    RegisterEdge(i, branch.TrueTarget, branch.TrueArguments);
                    RegisterEdge(i, branch.FalseTarget, branch.FalseArguments);
                    break;
                default: throw new FormatException("Unsupported CFG terminator");
            }
        }

        var visited = new bool[blocks.Length];
        var queue = new Queue<int>();
        visited[entry] = true;
        queue.Enqueue(entry);
        while (queue.Count != 0)
        {
            int current = queue.Dequeue();
            foreach (int target in successors[current])
                if (!visited[target])
                {
                    visited[target] = true;
                    queue.Enqueue(target);
                }
        }
        if (visited.Any(v => !v))
            throw new FormatException("Unreachable CFG block");

        // Forward dominator fixed point. Valid for loops, diamonds, and
        // arbitrary reachable CFGs, unlike block order as a dominance proxy.
        var dominators = new HashSet<int>[blocks.Length];
        for (int i = 0; i < blocks.Length; i++)
            dominators[i] = i == entry
                ? new HashSet<int> { entry }
                : new HashSet<int>(Enumerable.Range(0, blocks.Length));

        bool changed;
        do
        {
            changed = false;
            for (int i = 0; i < blocks.Length; i++)
            {
                if (i == entry) continue;
                var intersection = new HashSet<int>(dominators[predecessors[i][0]]);
                foreach (int parent in predecessors[i].Skip(1))
                    intersection.IntersectWith(dominators[parent]);
                intersection.Add(i);
                if (!dominators[i].SetEquals(intersection))
                {
                    dominators[i] = intersection;
                    changed = true;
                }
            }
        } while (changed);

        for (int i = 0; i < blocks.Length; i++)
        {
            var block = blocks[i];
            for (int opIndex = 0; opIndex < block.Instructions.Count; opIndex++)
            {
                var op = block.Instructions[opIndex];
                switch (op.Opcode)
                {
                    case CfgOpcode.ConstantI64:
                        RequireType(op.Type, IrValueType.I64);
                        if (op.I64Constant is null || op.BoolConstant is not null ||
                            op.Left is not null || op.Right is not null)
                            throw new FormatException("Malformed CFG i64 constant");
                        break;
                    case CfgOpcode.ConstantBool:
                        RequireType(op.Type, IrValueType.Bool);
                        if (op.BoolConstant is null || op.I64Constant is not null ||
                            op.Left is not null || op.Right is not null)
                            throw new FormatException("Malformed CFG bool constant");
                        break;
                    case CfgOpcode.CheckedAdd:
                    case CfgOpcode.CheckedSubtract:
                    case CfgOpcode.CheckedMultiply:
                    case CfgOpcode.CheckedDivide:
                    case CfgOpcode.EqualI64:
                    case CfgOpcode.LessThanI64:
                        RequireType(op.Type,
                            op.Opcode is CfgOpcode.EqualI64 or CfgOpcode.LessThanI64
                                ? IrValueType.Bool : IrValueType.I64);
                        if (op.Left is null || op.Right is null ||
                            op.I64Constant is not null || op.BoolConstant is not null)
                            throw new FormatException("Malformed CFG binary operation");
                        Use(i, opIndex, op.Left.Value, IrValueType.I64);
                        Use(i, opIndex, op.Right.Value, IrValueType.I64);
                        break;
                    default:
                        throw new FormatException("Unknown CFG opcode");
                }
            }

            int termIndex = block.Instructions.Count;
            switch (block.Terminator)
            {
                case CfgReturn returned:
                    Use(i, termIndex, returned.ValueId, function.ResultType);
                    break;
                case CfgJump jump:
                    VerifyEdgeValues(i, termIndex, jump.Target, jump.Arguments);
                    break;
                case CfgBranch condition:
                    Use(i, termIndex, condition.Condition, IrValueType.Bool);
                    VerifyEdgeValues(i, termIndex, condition.TrueTarget, condition.TrueArguments);
                    VerifyEdgeValues(i, termIndex, condition.FalseTarget, condition.FalseArguments);
                    break;
            }
        }

        return new VerifiedCfgFunction(function.Name, function.ResultType,
            function.Entry, Array.AsReadOnly(blocks));

        void AddDefinition(int id, IrValueType type, int block, int instruction)
        {
            if (id < 0 || type is not (IrValueType.I64 or IrValueType.Bool) ||
                !definitions.TryAdd(id, new Definition(block, instruction, type)))
                throw new FormatException("Invalid or duplicate CFG SSA definition");
            if (definitions.Count > MaxValues)
                throw new FormatException("CFG SSA value budget exceeded");
        }

        void RegisterEdge(int from, string targetName, IReadOnlyList<int> args)
        {
            if (!Identifier(targetName) || !indexes.TryGetValue(targetName, out int target))
                throw new FormatException("Invalid or missing CFG jump target");
            if (args.Count != blocks[target].Parameters.Count)
                throw new FormatException("CFG block argument arity mismatch");
            successors[from].Add(target);
            predecessors[target].Add(from);
        }

        void Use(int block, int atInstruction, int id, IrValueType required)
        {
            if (!definitions.TryGetValue(id, out var definition) || definition.Type != required)
                throw new FormatException("Undefined or mistyped CFG SSA use");
            if (definition.Block == block)
            {
                if (definition.Instruction >= atInstruction)
                    throw new FormatException("CFG SSA use precedes definition");
            }
            else if (!dominators[block].Contains(definition.Block))
                throw new FormatException("CFG SSA use not dominated by definition");
        }

        void VerifyEdgeValues(int from, int at, string targetName, IReadOnlyList<int> args)
        {
            int target = indexes[targetName];
            for (int i = 0; i < args.Count; i++)
                Use(from, at, args[i], blocks[target].Parameters[i].Type);
        }
    }

    // The caller's IReadOnlyList implementation is untrusted. Explicitly
    // indexed snapshots enforce the admitted Count bound even if its
    // IEnumerable enumerator yields infinitely many values. Never enumerate.
    private static IReadOnlyList<T> CopyIndexed<T>(IReadOnlyList<T> source, int count)
    {
        var copy = new T[count];
        for (int i = 0; i < count; i++)
            copy[i] = source[i];
        return Array.AsReadOnly(copy);
    }

    private static void RequireType(IrValueType actual, IrValueType expected)
    {
        if (actual != expected) throw new FormatException("CFG result type mismatch");
    }

    private static bool Identifier(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 128)
            return false;
        if (!Alpha(value[0]) && value[0] != '_') return false;
        foreach (char c in value.AsSpan(1))
            if (!Alpha(c) && c != '_' && c is not (>= '0' and <= '9'))
                return false;
        return true;
    }

    private static bool Alpha(char c) =>
        c is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z');
}
