namespace Ores.Net.Compiler;

/// <summary>
/// Experimental, non-shipping lowering of the bounded typed structured parser
/// into independently verified SSA CFG. No runtime execution or CLI routing.
/// A local is represented by its current SSA value, never a mutable IL slot.
/// </summary>
public static class OresStructuredCfgLowering
{
    public static VerifiedCfgFunction Lower(string source)
    {
        var parsed = OresStructuredParser.Parse(source);
        return new Builder().Lower(parsed);
    }

    private readonly record struct Binding(IrValueType Type, int ValueId);

    private sealed class Block(string name)
    {
        public string Name { get; } = name;
        public List<CfgParameter> Parameters { get; } = new();
        public List<CfgInstruction> Instructions { get; } = new();
        public CfgTerminator? Terminator { get; set; }

        public CfgBlock Freeze() => new(Name, Parameters.ToArray(),
            Instructions.ToArray(), Terminator ??
            throw new FormatException("Unterminated structured CFG block"));
    }

    private sealed class Builder
    {
        private readonly List<Block> blocks = new();
        private int nextValue;

        public VerifiedCfgFunction Lower(StructuredProgram program)
        {
            if (program.Name != "main")
                throw new FormatException("Only typed main is supported");
            var entry = NewBlock();
            var environment = new Dictionary<string, Binding>(StringComparer.Ordinal);
            if (EmitStatements(program.Body, entry, environment) is not null)
                throw new FormatException("Structured CFG has an unterminated return path");
            return OresCfgVerifier.Verify(new CfgFunction(program.Name,
                IrValueType.I64, entry.Name, blocks.Select(b => b.Freeze()).ToArray()));
        }

        private int NextValue()
        {
            if (nextValue >= OresCfgVerifier.MaxValues)
                throw new FormatException("Structured CFG SSA budget exceeded");
            return nextValue++;
        }

        private Block NewBlock()
        {
            if (blocks.Count >= OresCfgVerifier.MaxBlocks)
                throw new FormatException("Structured CFG block budget exceeded");
            var block = new Block(blocks.Count == 0 ? "entry" : "b" + blocks.Count);
            blocks.Add(block);
            return block;
        }

        private int Emit(Block block, CfgOpcode opcode, IrValueType type,
            int? left = null, int? right = null,
            long? value = null, bool? boolean = null)
        {
            int id = NextValue();
            block.Instructions.Add(new CfgInstruction(id, opcode, type,
                Left: left, Right: right, I64Constant: value, BoolConstant: boolean));
            return id;
        }

        private int Expression(StructuredExpr expression, Block block,
            Dictionary<string, Binding> variables)
        {
            switch (expression)
            {
                case StructuredInt number:
                    return Emit(block, CfgOpcode.ConstantI64, IrValueType.I64,
                        value: number.Value);
                case StructuredBool boolean:
                    return Emit(block, CfgOpcode.ConstantBool, IrValueType.Bool,
                        boolean: boolean.Value);
                case StructuredRead read:
                    if (!variables.TryGetValue(read.Name, out var variable) ||
                        variable.Type != read.Type)
                        throw new FormatException("Unbound structured CFG local");
                    return variable.ValueId;
                case StructuredNegate negate:
                {
                    int zero = Emit(block, CfgOpcode.ConstantI64, IrValueType.I64, value: 0);
                    int operand = Expression(negate.Value, block, variables);
                    return Emit(block, CfgOpcode.CheckedSubtract, IrValueType.I64,
                        left: zero, right: operand);
                }
                case StructuredBinary binary:
                {
                    int left = Expression(binary.Left, block, variables);
                    int right = Expression(binary.Right, block, variables);
                    var opcode = binary.Operator switch
                    {
                        StructuredOperator.Add => CfgOpcode.CheckedAdd,
                        StructuredOperator.Subtract => CfgOpcode.CheckedSubtract,
                        StructuredOperator.Multiply => CfgOpcode.CheckedMultiply,
                        StructuredOperator.EqualI64 => CfgOpcode.EqualI64,
                        StructuredOperator.LessThanI64 => CfgOpcode.LessThanI64,
                        _ => throw new FormatException("Unsupported structured operation")
                    };
                    return Emit(block, opcode, binary.Type, left: left, right: right);
                }
                default:
                    throw new FormatException("Unsupported structured CFG expression");
            }
        }

        private static string[] Names(Dictionary<string, Binding> variables) =>
            variables.Keys.OrderBy(name => name, StringComparer.Ordinal).ToArray();

        private Block Join(string[] names, Dictionary<string, Binding> source,
            Dictionary<string, Binding> result)
        {
            var destination = NewBlock();
            foreach (string name in names)
            {
                int id = NextValue();
                var type = source[name].Type;
                destination.Parameters.Add(new CfgParameter(id, type));
                result[name] = new Binding(type, id);
            }
            return destination;
        }

        private static int[] Values(string[] names,
            Dictionary<string, Binding> variables) =>
            names.Select(name => variables[name].ValueId).ToArray();

        private Block? EmitStatements(IReadOnlyList<StructuredStmt> statements,
            Block start, Dictionary<string, Binding> variables)
        {
            Block? current = start;
            foreach (var stmt in statements)
            {
                if (current is null)
                    throw new FormatException("Unreachable structured CFG statement");
                switch (stmt)
                {
                    case StructuredLet declaration:
                    {
                        if (variables.ContainsKey(declaration.Name))
                            throw new FormatException("Shadowed structured CFG local");
                        int value = Expression(declaration.Initializer, current, variables);
                        variables.Add(declaration.Name, new Binding(declaration.ValueType, value));
                        break;
                    }
                    case StructuredSet assignment:
                    {
                        if (!variables.TryGetValue(assignment.Name, out var original))
                            throw new FormatException("Unknown structured CFG assignment");
                        int value = Expression(assignment.Value, current, variables);
                        variables[assignment.Name] = new Binding(original.Type, value);
                        break;
                    }
                    case StructuredReturn returned:
                        current.Terminator = new CfgReturn(
                            Expression(returned.Value, current, variables));
                        current = null;
                        break;
                    case StructuredIf conditional:
                        current = If(conditional, current, variables);
                        break;
                    case StructuredWhile loop:
                        current = While(loop, current, variables);
                        break;
                    default:
                        throw new FormatException("Unsupported structured CFG statement");
                }
            }
            return current;
        }

        private Block? If(StructuredIf statement, Block origin,
            Dictionary<string, Binding> variables)
        {
            int condition = Expression(statement.Condition, origin, variables);
            var names = Names(variables);
            var thenBlock = NewBlock();
            var thenEnvironment = new Dictionary<string, Binding>(
                variables, StringComparer.Ordinal);
            Block? thenEnd = EmitStatements(statement.Then, thenBlock, thenEnvironment);

            Block? elseBlock = null;
            Block? elseEnd = null;
            var elseEnvironment = new Dictionary<string, Binding>(
                variables, StringComparer.Ordinal);
            if (statement.Else is not null)
            {
                elseBlock = NewBlock();
                elseEnd = EmitStatements(statement.Else, elseBlock, elseEnvironment);
            }

            if (thenEnd is null && statement.Else is not null && elseEnd is null)
            {
                origin.Terminator = new CfgBranch(condition, thenBlock.Name,
                    Array.Empty<int>(), elseBlock!.Name, Array.Empty<int>());
                return null;
            }

            var joined = new Dictionary<string, Binding>(StringComparer.Ordinal);
            Block join = Join(names, variables, joined);
            if (thenEnd is not null)
                thenEnd.Terminator = new CfgJump(join.Name, Values(names, thenEnvironment));
            if (statement.Else is null)
                origin.Terminator = new CfgBranch(condition, thenBlock.Name,
                    Array.Empty<int>(), join.Name, Values(names, variables));
            else
            {
                if (elseEnd is not null)
                    elseEnd.Terminator = new CfgJump(join.Name, Values(names, elseEnvironment));
                origin.Terminator = new CfgBranch(condition, thenBlock.Name,
                    Array.Empty<int>(), elseBlock!.Name, Array.Empty<int>());
            }
            foreach (string name in names)
                variables[name] = joined[name];
            return join;
        }

        private Block While(StructuredWhile statement, Block origin,
            Dictionary<string, Binding> variables)
        {
            var names = Names(variables);
            var headerVariables = new Dictionary<string, Binding>(StringComparer.Ordinal);
            Block header = Join(names, variables, headerVariables);
            origin.Terminator = new CfgJump(header.Name, Values(names, variables));

            int condition = Expression(statement.Condition, header, headerVariables);
            Block body = NewBlock();
            var bodyVariables = new Dictionary<string, Binding>(
                headerVariables, StringComparer.Ordinal);
            Block? bodyEnd = EmitStatements(statement.Body, body, bodyVariables);
            if (bodyEnd is not null)
                bodyEnd.Terminator = new CfgJump(header.Name, Values(names, bodyVariables));

            var exitVariables = new Dictionary<string, Binding>(StringComparer.Ordinal);
            Block exit = Join(names, headerVariables, exitVariables);
            header.Terminator = new CfgBranch(condition, body.Name,
                Array.Empty<int>(), exit.Name, Values(names, headerVariables));
            foreach (string name in names)
                variables[name] = exitVariables[name];
            return exit;
        }
    }
}
