using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;

namespace Ores.Net.Compiler;

/// <summary>
/// Build-time lowering of a verified typed CFG to CIL. No guest code runs
/// during compilation, and all control-flow destinations are predeclared.
/// </summary>
internal static class CfgCilEmitter
{
    public static void EmitLibrary(VerifiedCfgFunction graph, string outputFile)
    {
        ArgumentNullException.ThrowIfNull(graph);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputFile);

        CilEmitter.EmitLibraryCore(outputFile, (metadata, bodies) =>
        {
            var blocks = graph.Blocks;
            int valueCount = blocks.Sum(b => b.Parameters.Count + b.Instructions.Count);
            int scratchCount = blocks.Sum(b => b.Parameters.Count);
            if (valueCount is <= 0 or > OresCfgVerifier.MaxValues ||
                scratchCount > OresCfgVerifier.MaxValues)
                throw new FormatException("CFG CIL local slot budget exceeded");

            // First part of the local table is indexed by global dense SSA ID.
            // The second part reserves *target-typed* edge scratch slots.
            // Capturing all source values before touching block parameters
            // makes edge assignments simultaneous, including swaps.
            var types = new IrValueType[valueCount + scratchCount];
            var targetScratch = new Dictionary<string, int[]>(StringComparer.Ordinal);
            var targetParameters = new Dictionary<string, IReadOnlyList<CfgParameter>>(
                StringComparer.Ordinal);
            int nextScratch = valueCount;
            foreach (var block in blocks)
            {
                foreach (var parameter in block.Parameters)
                    types[parameter.Id] = parameter.Type;
                foreach (var op in block.Instructions)
                    types[op.ResultId] = op.Type;

                var slots = new int[block.Parameters.Count];
                for (int i = 0; i < slots.Length; i++)
                {
                    slots[i] = nextScratch;
                    types[nextScratch++] = block.Parameters[i].Type;
                }
                targetScratch.Add(block.Name, slots);
                targetParameters.Add(block.Name, block.Parameters);
            }
            if (nextScratch != types.Length)
                throw new FormatException("CFG local layout is inconsistent");

            var signatureBlob = new BlobBuilder();
            var locals = new BlobEncoder(signatureBlob).LocalVariableSignature(types.Length);
            foreach (var type in types)
            {
                var encoded = locals.AddVariable().Type();
                switch (type)
                {
                    case IrValueType.I64: encoded.Int64(); break;
                    case IrValueType.Bool: encoded.Boolean(); break;
                    default: throw new FormatException("Unsupported CFG local type");
                }
            }
            var signature = metadata.AddStandaloneSignature(
                metadata.GetOrAddBlob(signatureBlob));

            var code = new BlobBuilder();
            var il = new InstructionEncoder(code, new ControlFlowBuilder());
            var labels = new Dictionary<string, LabelHandle>(StringComparer.Ordinal);
            foreach (var block in blocks)
                labels.Add(block.Name, il.DefineLabel());

            // The input list is not required to put its entry block first.
            // A jump to the entry is explicit; there is no implicit fallthrough.
            il.Branch(ILOpCode.Br, labels[graph.Entry]);

            void Transfer(string destination, IReadOnlyList<int> arguments)
            {
                var scratch = targetScratch[destination];
                var destinationParameters = targetParameters[destination];
                if (scratch.Length != arguments.Count)
                    throw new FormatException("Unverified CFG edge arity");

                // Stage all incoming values before clobbering any destination.
                for (int i = 0; i < arguments.Count; i++)
                {
                    il.LoadLocal(arguments[i]);
                    il.StoreLocal(scratch[i]);
                }
                for (int i = 0; i < arguments.Count; i++)
                {
                    il.LoadLocal(scratch[i]);
                    il.StoreLocal(destinationParameters[i].Id);
                }
                il.Branch(ILOpCode.Br, labels[destination]);
            }

            foreach (var block in blocks)
            {
                il.MarkLabel(labels[block.Name]);
                foreach (var op in block.Instructions)
                {
                    switch (op.Opcode)
                    {
                        case CfgOpcode.ConstantI64:
                            il.LoadConstantI8(op.I64Constant!.Value);
                            break;
                        case CfgOpcode.ConstantBool:
                            il.LoadConstantI4(op.BoolConstant!.Value ? 1 : 0);
                            break;
                        case CfgOpcode.CheckedAdd:
                        case CfgOpcode.CheckedSubtract:
                        case CfgOpcode.CheckedMultiply:
                        case CfgOpcode.CheckedDivide:
                        case CfgOpcode.EqualI64:
                        case CfgOpcode.LessThanI64:
                            il.LoadLocal(op.Left!.Value);
                            il.LoadLocal(op.Right!.Value);
                            il.OpCode(op.Opcode switch
                            {
                                CfgOpcode.CheckedAdd => ILOpCode.Add_ovf,
                                CfgOpcode.CheckedSubtract => ILOpCode.Sub_ovf,
                                CfgOpcode.CheckedMultiply => ILOpCode.Mul_ovf,
                                CfgOpcode.CheckedDivide => ILOpCode.Div,
                                CfgOpcode.EqualI64 => ILOpCode.Ceq,
                                CfgOpcode.LessThanI64 => ILOpCode.Clt,
                                _ => throw new FormatException("Unverified CFG opcode")
                            });
                            break;
                        default:
                            throw new FormatException("Unverified CFG instruction");
                    }
                    il.StoreLocal(op.ResultId);
                }

                switch (block.Terminator)
                {
                    case CfgReturn returned:
                        il.LoadLocal(returned.ValueId);
                        il.OpCode(ILOpCode.Ret);
                        break;
                    case CfgJump jump:
                        Transfer(jump.Target, jump.Arguments);
                        break;
                    case CfgBranch conditional:
                        // brtrue consumes the condition and leaves an empty
                        // stack at BOTH successor transfer sequences.
                        var trueEdge = il.DefineLabel();
                        il.LoadLocal(conditional.Condition);
                        il.Branch(ILOpCode.Brtrue, trueEdge);
                        Transfer(conditional.FalseTarget, conditional.FalseArguments);
                        il.MarkLabel(trueEdge);
                        Transfer(conditional.TrueTarget, conditional.TrueArguments);
                        break;
                    default:
                        throw new FormatException("Unverified CFG terminator");
                }
            }

            // An explicit byte budget keeps CIL assembly serialization
            // bounded even when the verifier allows many large edge payloads.
            const int maxMethodCodeBytes = 4 * 1024 * 1024;
            if (code.Count > maxMethodCodeBytes)
                throw new FormatException("CFG CIL bytecode budget exceeded");

            // Every block is entered with an empty stack, each instruction
            // stores its result immediately, and the maximum temporary depth
            // is two (binary operation); control-flow edges never merge stacks.
            int offset = bodies.AddMethodBody(il, maxStack: 2,
                localVariablesSignature: signature,
                attributes: MethodBodyAttributes.InitLocals);
            return (offset, code, signatureBlob);
        });
    }
}
