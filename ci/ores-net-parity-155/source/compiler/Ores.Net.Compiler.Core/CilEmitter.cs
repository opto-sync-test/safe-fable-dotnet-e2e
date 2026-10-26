using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;

namespace Ores.Net.Compiler;

/// <summary>
/// Build-time, metadata-only CIL emitter. Never loads generated assemblies or
/// generates runtime code; compatible with .NET Native AOT and strict trimming.
/// </summary>
public static class CilEmitter
{
    private const int MaxAstNodes = 100_000;
    // The CLR method header stores the maximum evaluation stack depth.
    // Keep this far below the ECMA-335 maximum to bound compiler work.
    private const int MaxEvaluationStack = 256;

    public static void EmitLibrary(Expression program, string outputFile)
    {
        ArgumentNullException.ThrowIfNull(program);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputFile);

        EmitLibraryCore(outputFile, (metadata, bodies) =>
        {
            var methodCode = new BlobBuilder();
            var instructions = new InstructionEncoder(methodCode);
            int maxStack = Write(program, instructions);
            instructions.OpCode(ILOpCode.Ret);
            int bodyOffset = bodies.AddMethodBody(instructions, maxStack: maxStack);
            return (bodyOffset, methodCode, null);
        });
    }

    // Production path: only a verified OresIR function may reach the CIL
    // backend. Each SSA value has a typed i64 local slot, so shared subgraphs
    // and unused instructions have defined, non-exponential execution.
    public static void EmitLibrary(VerifiedIrFunction program, string outputFile)
    {
        ArgumentNullException.ThrowIfNull(program);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputFile);
        const int maxLocalSlots = 16_384;
        if (program.Instructions.Count > maxLocalSlots)
            throw new FormatException("OresIR CIL local slot budget exceeded");

        EmitLibraryCore(outputFile, (metadata, bodies) =>
        {
            int count = program.Instructions.Count;
            var localsBlob = new BlobBuilder();
            var locals = new BlobEncoder(localsBlob).LocalVariableSignature(count);
            for (int i = 0; i < count; i++)
                locals.AddVariable().Type().Int64();
            var localSignature = metadata.AddStandaloneSignature(
                metadata.GetOrAddBlob(localsBlob));

            var methodCode = new BlobBuilder();
            var il = new InstructionEncoder(methodCode);
            int maxStack = WriteVerifiedIr(program, il);
            int bodyOffset = bodies.AddMethodBody(il, maxStack: maxStack,
                localVariablesSignature: localSignature,
                attributes: MethodBodyAttributes.InitLocals);
            return (bodyOffset, methodCode, localsBlob);
        });
    }

    // Experimental CFG entry point. Only VerifiedCfgFunction is accepted;
    // the source CLI remains on verified straight-line OresIR until the
    // CFG differential suite is proven green.
    public static void EmitLibrary(VerifiedCfgFunction program, string outputFile) =>
        CfgCilEmitter.EmitLibrary(program, outputFile);

    private static int WriteVerifiedIr(VerifiedIrFunction program, InstructionEncoder il)
    {
        int maxStack = 1;
        foreach (var operation in program.Instructions)
        {
            switch (operation.Opcode)
            {
                case IrOpcode.ConstantI64:
                    il.LoadConstantI8(operation.Constant!.Value);
                    break;
                case IrOpcode.CheckedAdd:
                case IrOpcode.CheckedSubtract:
                case IrOpcode.CheckedMultiply:
                case IrOpcode.CheckedDivide:
                    il.LoadLocal(operation.Left!.Value);
                    il.LoadLocal(operation.Right!.Value);
                    il.OpCode(operation.Opcode switch
                    {
                        IrOpcode.CheckedAdd => ILOpCode.Add_ovf,
                        IrOpcode.CheckedSubtract => ILOpCode.Sub_ovf,
                        IrOpcode.CheckedMultiply => ILOpCode.Mul_ovf,
                        _ => ILOpCode.Div
                    });
                    maxStack = 2;
                    break;
                default:
                    throw new FormatException("Unsupported verified IR opcode");
            }
            // Evaluation stack is empty between SSA definitions.
            il.StoreLocal(operation.ResultId);
        }
        il.LoadLocal(program.ReturnId);
        il.OpCode(ILOpCode.Ret);
        return maxStack;
    }

    internal static void EmitLibraryCore(string outputFile,
        Func<MetadataBuilder, MethodBodyStreamEncoder,
            (int BodyOffset, BlobBuilder Code, BlobBuilder? Locals)> buildBody)
    {
        var ilStream = new BlobBuilder();
        var bodyStream = new MethodBodyStreamEncoder(ilStream);
        var metadata = new MetadataBuilder();
        var (bodyOffset, _, localSignatureBlob) = buildBody(metadata, bodyStream);
        // The finalized method body includes branch fixups and the signature
        // *token*, but the token number is not a fingerprint of its blob.
        // Two programs can have identical IL and signature token 0x11000001
        // while having different typed local signatures. Hash both inputs.
        using var contentHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        contentHash.AppendData(ilStream.ToArray());
        if (localSignatureBlob is not null)
            contentHash.AppendData(localSignatureBlob.ToArray());
        byte[] hash = contentHash.GetHashAndReset();
        var moduleId = new Guid(hash.AsSpan(0, 16));
        metadata.AddModule(
            generation: 0,
            moduleName: metadata.GetOrAddString("OresGenerated.dll"),
            mvid: metadata.GetOrAddGuid(moduleId),
            encId: default,
            encBaseId: default);
        metadata.AddAssembly(
            metadata.GetOrAddString("OresGenerated"),
            new Version(1, 0, 0, 0),
            culture: default,
            publicKey: default,
            flags: default,
            hashAlgorithm: System.Reflection.AssemblyHashAlgorithm.None);

        var runtime = metadata.AddAssemblyReference(
            metadata.GetOrAddString("System.Runtime"),
            new Version(10, 0, 0, 0),
            culture: default,
            // System.Runtime carries the Microsoft strong-name token; emitting a
            // token-less reference prevents downstream C# and Native AOT binding.
            publicKeyOrToken: metadata.GetOrAddBlob(new byte[] { 0xB0, 0x3F, 0x5F, 0x7F, 0x11, 0xD5, 0x0A, 0x3A }),
            flags: default,
            hashValue: default);
        var systemObject = metadata.AddTypeReference(
            runtime,
            metadata.GetOrAddString("System"),
            metadata.GetOrAddString("Object"));

        var signature = new BlobBuilder();
        new BlobEncoder(signature).MethodSignature().Parameters(
            0,
            returnType => returnType.Type().Int64(),
            parameters => { });

        // Method and type tables are ordered deliberately: <Module> owns zero
        // methods, and the public static OresProgram owns method row #1.
        var run = metadata.AddMethodDefinition(
            MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.HideBySig,
            MethodImplAttributes.IL,
            metadata.GetOrAddString("Run"),
            metadata.GetOrAddBlob(signature),
            bodyOffset,
            MetadataTokens.ParameterHandle(1));

        metadata.AddTypeDefinition(
            default, default, metadata.GetOrAddString("<Module>"),
            default, MetadataTokens.FieldDefinitionHandle(1), run);
        metadata.AddTypeDefinition(
            TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed |
            TypeAttributes.Class | TypeAttributes.BeforeFieldInit,
            metadata.GetOrAddString("Oreslang.Generated"),
            metadata.GetOrAddString("OresProgram"),
            systemObject,
            MetadataTokens.FieldDefinitionHandle(1),
            run);

        var pe = new ManagedPEBuilder(
            new PEHeaderBuilder(imageCharacteristics:
                Characteristics.ExecutableImage | Characteristics.Dll),
            new MetadataRootBuilder(metadata),
            ilStream,
            strongNameSignatureSize: 0,
            flags: CorFlags.ILOnly,
            deterministicIdProvider: DeterministicImageId);
        var peBytes = new BlobBuilder();
        pe.Serialize(peBytes);

        var fullPath = Path.GetFullPath(outputFile);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        var temporary = fullPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllBytes(temporary, peBytes.ToArray());
            File.Move(temporary, fullPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    // Without an explicit provider PEBuilder creates a time-based COFF stamp,
    // even when the metadata MVID is stable. Hash the entire pre-stamped
    // content to produce a reproducible native-toolchain input.
    private static BlobContentId DeterministicImageId(IEnumerable<Blob> blobs)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var blob in blobs)
            hash.AppendData(blob.GetBytes().AsSpan());
        return BlobContentId.FromHash(hash.GetHashAndReset());
    }

    private readonly record struct Pending(Expression Node, bool EmitOperator);

    // A flat expression such as a+b+c+... may create thousands of AST nodes,
    // even with shallow source nesting. Traversal MUST NOT recurse on the CLR
    // call stack. Emit exact postorder CIL and track its evaluation stack.
    private static int Write(Expression root, InstructionEncoder il)
    {
        var pending = new Stack<Pending>();
        pending.Push(new Pending(root, false));
        int nodes = 0;
        int evaluationDepth = 0;
        int maximum = 0;

        while (pending.Count > 0)
        {
            var work = pending.Pop();
            if (work.EmitOperator)
            {
                if (evaluationDepth < 2)
                    throw new FormatException("Invalid CIL operator stack");
                var opcode = work.Node switch
                {
                    Unary { Operator: '-' } => ILOpCode.Sub_ovf,
                    Binary { Operator: '+' } => ILOpCode.Add_ovf,
                    Binary { Operator: '-' } => ILOpCode.Sub_ovf,
                    Binary { Operator: '*' } => ILOpCode.Mul_ovf,
                    Binary { Operator: '/' } => ILOpCode.Div,
                    _ => throw new FormatException("Invalid CIL operator")
                };
                il.OpCode(opcode);
                evaluationDepth--;
            }
            else
            {
                if (++nodes > MaxAstNodes)
                    throw new FormatException("AST budget exceeded");

                switch (work.Node)
                {
                    case Literal literal:
                        il.LoadConstantI8(literal.Value);
                        evaluationDepth++;
                        break;
                    case Unary { Operator: '+' } unary:
                        pending.Push(new Pending(unary.Value, false));
                        break;
                    case Unary { Operator: '-' } unary:
                        il.LoadConstantI8(0);
                        evaluationDepth++;
                        pending.Push(new Pending(unary, true));
                        pending.Push(new Pending(unary.Value, false));
                        break;
                    case Binary binary when binary.Operator is '+' or '-' or '*' or '/':
                        pending.Push(new Pending(binary, true));
                        pending.Push(new Pending(binary.Right, false));
                        pending.Push(new Pending(binary.Left, false));
                        break;
                    default:
                        throw new FormatException("Unsupported AST expression");
                }
            }
            maximum = Math.Max(maximum, evaluationDepth);
            if (maximum > MaxEvaluationStack)
                throw new FormatException("CIL evaluation stack budget exceeded");
        }

        if (evaluationDepth != 1 || maximum < 1)
            throw new FormatException("Invalid final CIL stack");
        return maximum;
    }
}
