using Mono.Cecil;
using Mono.Cecil.Cil;
using Ores.Net.Compiler;

/// <summary>
/// Exercises boundaries that the tiny hand-written CFG tests cannot reach:
/// long branch offsets, 16-bit local indexes, and both sides of a branch.
/// This interpreter is test-only: it never loads untrusted generated assemblies.
/// </summary>
internal static class CfgCilStressTests
{
    public static void Run()
    {
        CheckLongBranchesAndLocals(condition: true);
        CheckLongBranchesAndLocals(condition: false);
        CheckLongBranchesAndLocals(condition: true, reordered: true);
        CheckSharedSuccessorEdges(condition: true, expected: 11);
        CheckSharedSuccessorEdges(condition: false, expected: 22);
    }

    private static void CheckLongBranchesAndLocals(bool condition, bool reordered = false)
    {
        const int paddingCount = 640;
        const int finalId = 3 + paddingCount;
        var paddingOps = Enumerable.Range(0, paddingCount)
            .Select(i => new CfgInstruction(i + 3, CfgOpcode.ConstantI64,
                IrValueType.I64, I64Constant: i))
            .ToArray();

        var entry = new CfgBlock("entry", Array.Empty<CfgParameter>(),
            new[] {
                new CfgInstruction(0, CfgOpcode.ConstantBool,
                    IrValueType.Bool, BoolConstant: condition),
                new CfgInstruction(1, CfgOpcode.ConstantI64,
                    IrValueType.I64, I64Constant: 77)
            },
            new CfgBranch(0, "finish", new[] { 1 }, "padding", new[] { 1 }));
        var padding = new CfgBlock("padding",
            new[] { new CfgParameter(2, IrValueType.I64) },
            paddingOps,
            new CfgJump("finish", new[] { 2 }));
        var finish = new CfgBlock("finish",
            new[] { new CfgParameter(finalId, IrValueType.I64) },
            Array.Empty<CfgInstruction>(),
            new CfgReturn(finalId));

        // The physical position of the entry and join blocks must not affect
        // dominance or CIL branch-target placement.
        var blocks = reordered
            ? new[] { finish, padding, entry }
            : new[] { entry, padding, finish };

        var graph = OresCfgVerifier.Verify(new CfgFunction(
            "stress", IrValueType.I64, "entry", blocks));
        Require(CfgReferenceEvaluator.Evaluate(graph) == 77,
            "CFG reference interpreter long-branch result");

        string directory = Path.Combine(Path.GetTempPath(),
            "ores-cfg-stress-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var output = Path.Combine(directory, "OresGenerated.dll");
            CilEmitter.EmitLibrary(graph, output);
            using var assembly = AssemblyDefinition.ReadAssembly(output);
            var method = assembly.MainModule.Types.Single(t =>
                t.FullName == "Oreslang.Generated.OresProgram")
                .Methods.Single(m => m.Name == "Run");

            Require(method.Body.Variables.Count == finalId + 3,
                "CFG local-signature count includes >255 SSA indexes and scratch slots");
            Require(method.Body.Variables[0].VariableType.MetadataType == MetadataType.Boolean,
                "CFG branch condition uses an actual bool local");
            Require(method.Body.Variables[finalId].VariableType.MetadataType == MetadataType.Int64,
                "CFG late result is an i64 local");
            Require(method.Body.Instructions.Any(i => i.OpCode.Code == Code.Ldloc),
                "CFG emits 16-bit local loads");
            Require(method.Body.Instructions.Any(i => i.OpCode.Code == Code.Stloc),
                "CFG emits 16-bit local stores");
            // A conditional branch skips only the short false-edge transfer.
            // The large displacement is on an unconditional jump across the
            // padding block (or the synthetic jump to a reordered entry).
            // ECMA-335 long-form br and brtrue are each five bytes.
            Require(method.Body.Instructions.Any(i =>
                i.OpCode.Code == Code.Brtrue &&
                Math.Abs(((Instruction)i.Operand).Offset - (i.Offset + 5)) <= 127),
                "CFG true-edge selection skips only its short false transfer");
            Require(method.Body.Instructions.Any(i =>
                i.OpCode.Code == Code.Br &&
                Math.Abs(((Instruction)i.Operand).Offset - (i.Offset + 5)) > 127),
                "CFG encodes a real >127-byte unconditional branch displacement");
            Require(method.Body.InitLocals,
                "CFG local initialization flag is set for large methods");
            Require(method.Body.MaxStackSize == 2,
                "CFG stack is bounded regardless of body length");

            var emitted = CfgCilTestInterpreter.Evaluate(method);
            Require(emitted == 77, "CFG long-distance CIL branch executes correctly");

            var repeat = Path.Combine(directory, "OresGenerated.repeat.dll");
            CilEmitter.EmitLibrary(graph, repeat);
            Require(File.ReadAllBytes(output).AsSpan()
                .SequenceEqual(File.ReadAllBytes(repeat)),
                "CFG stress assembly generation is deterministic");
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static void CheckSharedSuccessorEdges(bool condition, long expected)
    {
        // Both conditional destinations name the same block but carry
        // different values. The chosen *edge* determines the SSA argument.
        var graph = OresCfgVerifier.Verify(new CfgFunction(
            "sharedSuccessor", IrValueType.I64, "entry", new[] {
                new CfgBlock("entry", Array.Empty<CfgParameter>(), new[] {
                    new CfgInstruction(0, CfgOpcode.ConstantBool, IrValueType.Bool,
                        BoolConstant: condition),
                    new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                        I64Constant: 11),
                    new CfgInstruction(2, CfgOpcode.ConstantI64, IrValueType.I64,
                        I64Constant: 22)
                }, new CfgBranch(0, "join", new[] { 1 }, "join", new[] { 2 })),
                new CfgBlock("join",
                    new[] { new CfgParameter(3, IrValueType.I64) },
                    Array.Empty<CfgInstruction>(), new CfgReturn(3))
            }));

        var folder = Path.Combine(Path.GetTempPath(),
            "ores-cfg-shared-successor-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            var output = Path.Combine(folder, "OresGenerated.dll");
            CilEmitter.EmitLibrary(graph, output);
            using var assembly = AssemblyDefinition.ReadAssembly(output);
            var method = assembly.MainModule.Types.Single(t =>
                t.FullName == "Oreslang.Generated.OresProgram")
                .Methods.Single(m => m.Name == "Run");
            Require(CfgReferenceEvaluator.Evaluate(graph) == expected,
                "shared successor reference argument");
            Require(CfgCilTestInterpreter.Evaluate(method) == expected,
                "shared successor CIL chooses the correct edge argument");
            Require(method.Body.InitLocals, "CFG locals initialized by method header");
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    private static void Require(bool success, string why)
    {
        if (!success) throw new Exception("CFG stress regression: " + why);
    }
}
