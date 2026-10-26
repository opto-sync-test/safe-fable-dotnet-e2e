using Ores.Net.Compiler;

// Build-time-only fixture generator. The resulting OresGenerated.dll is
// statically referenced and consumed by the Native AOT publishing toolchain;
// this process never loads or executes guest code.
if (args.Length != 1 ||
    !string.Equals(Path.GetFileName(args[0]), "OresGenerated.dll",
        StringComparison.OrdinalIgnoreCase))
{
    Console.Error.WriteLine("usage: cfg-fixture path/OresGenerated.dll");
    return 2;
}

// Entry: a=11, b=22, flag=true. The first trip around the loop swaps a and
// b by passing them as block arguments, and disables the next iteration.
// Return (a * 100 + b) = 2211. Sequential edge stores would produce 2222.
var graph = new CfgFunction("swap", IrValueType.I64, "entry",
    new[] {
        new CfgBlock("entry", Array.Empty<CfgParameter>(), new[] {
            new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                I64Constant: 11),
            new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                I64Constant: 22),
            new CfgInstruction(2, CfgOpcode.ConstantBool, IrValueType.Bool,
                BoolConstant: true)
        }, new CfgJump("loop", new[] { 0, 1, 2 })),
        new CfgBlock("loop", new[] {
            new CfgParameter(3, IrValueType.I64),
            new CfgParameter(4, IrValueType.I64),
            new CfgParameter(5, IrValueType.Bool)
        }, new[] {
            new CfgInstruction(6, CfgOpcode.ConstantBool, IrValueType.Bool,
                BoolConstant: false)
        }, new CfgBranch(5, "loop", new[] { 4, 3, 6 },
            "finish", new[] { 3, 4 })),
        new CfgBlock("finish", new[] {
            new CfgParameter(7, IrValueType.I64),
            new CfgParameter(8, IrValueType.I64)
        }, new[] {
            new CfgInstruction(9, CfgOpcode.ConstantI64, IrValueType.I64,
                I64Constant: 100),
            new CfgInstruction(10, CfgOpcode.CheckedMultiply, IrValueType.I64,
                Left: 7, Right: 9),
            new CfgInstruction(11, CfgOpcode.CheckedAdd, IrValueType.I64,
                Left: 10, Right: 8)
        }, new CfgReturn(11))
    });
try
{
    CilEmitter.EmitLibrary(OresCfgVerifier.Verify(graph), args[0]);
    Console.WriteLine("Emitted verified CFG CIL fixture: " + Path.GetFullPath(args[0]));
    return 0;
}
catch (Exception ex) when (ex is FormatException or IOException or UnauthorizedAccessException)
{
    Console.Error.WriteLine("cfg-fixture: " + ex.Message);
    return 1;
}
