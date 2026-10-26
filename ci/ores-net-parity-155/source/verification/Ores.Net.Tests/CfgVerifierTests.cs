using Mono.Cecil;
using Ores.Net.Compiler;

internal static class CfgVerifierTests
{
    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new Exception("CFG test failed: " + message);
    }

    private static void Reject(CfgFunction function, string why)
    {
        try { _ = OresCfgVerifier.Verify(function); }
        catch (FormatException) { return; }
        throw new Exception("Expected CFG verification failure: " + why);
    }

    // Used to prove that oversized untrusted collections are rejected from
    // Count alone, before any potentially unbounded copy/enumeration begins.
    private sealed class PoisonCountList<T>(int count) : IReadOnlyList<T>
    {
        public int Count => count;
        public T this[int index] => throw new InvalidOperationException(
            "Unbounded CFG list was indexed before admission");
        public IEnumerator<T> GetEnumerator() => throw new InvalidOperationException(
            "Unbounded CFG list was enumerated before admission");
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() =>
            GetEnumerator();
    }

    // Legitimate IReadOnlyList input may support indexing but deliberately
    // refuse IEnumerable enumeration. Verification must never enumerate it.
    // A hostile iterator could otherwise yield without bound despite Count.
    private sealed class IndexedOnlyList<T>(T[] items) : IReadOnlyList<T>
    {
        public int Count => items.Length;
        public T this[int index] => items[index];
        public IEnumerator<T> GetEnumerator() =>
            throw new InvalidOperationException("Verifier enumerated untrusted IReadOnlyList");
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() =>
            GetEnumerator();
    }

    // Prove the admitted Count is cached before copying. A second read from
    // this adversarial collection reports a dangerous, unbounded size.
    private sealed class CountDriftList<T>(T[] items) : IReadOnlyList<T>
    {
        private int reads;
        public int Count => reads++ == 0 ? items.Length : int.MaxValue;
        public T this[int index] => items[index];
        public IEnumerator<T> GetEnumerator() =>
            throw new InvalidOperationException("Verifier enumerated drifting IReadOnlyList");
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() =>
            GetEnumerator();
    }

    private static CfgBlock Block(
        string name, CfgParameter[] parameters,
        CfgInstruction[] instructions, CfgTerminator terminator) =>
        new(name, parameters, instructions, terminator);

    public static void Run()
    {
        // All four collection positions (blocks, parameters, instructions,
        // edge arguments) must be copied by *indexed, admitted counts* only.
        var indexedEntry = new CfgBlock("start",
            new IndexedOnlyList<CfgParameter>(Array.Empty<CfgParameter>()),
            new IndexedOnlyList<CfgInstruction>(new[] {
                new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 17)
            }),
            new CfgJump("finish", new IndexedOnlyList<int>(new[] { 0 })));
        var indexedFinish = new CfgBlock("finish",
            new IndexedOnlyList<CfgParameter>(new[] {
                new CfgParameter(1, IrValueType.I64)
            }),
            new IndexedOnlyList<CfgInstruction>(Array.Empty<CfgInstruction>()),
            new CfgReturn(1));
        var indexed = new CfgFunction("indexed", IrValueType.I64, "start",
            new IndexedOnlyList<CfgBlock>(new[] { indexedEntry, indexedFinish }));
        CheckCil(OresCfgVerifier.Verify(indexed), 17, "indexed-only-untrusted-collections");

        var driftEntry = new CfgBlock("entry",
            new CountDriftList<CfgParameter>(Array.Empty<CfgParameter>()),
            new CountDriftList<CfgInstruction>(new[] {
                new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 23)
            }), new CfgReturn(0));
        var drift = new CfgFunction("drift", IrValueType.I64, "entry",
            new CountDriftList<CfgBlock>(new[] { driftEntry }));
        CheckCil(OresCfgVerifier.Verify(drift), 23, "count-drift-safe-snapshot");

        // Signed less-than must not be implemented using unsigned clt.un
        // or checked subtraction (which can overflow at i64 boundaries).
        foreach (var (a, bValue, expected) in new (long, long, bool)[] {
            (long.MinValue, long.MaxValue, true),
            (long.MaxValue, long.MinValue, false),
            (-1L, 0L, true),
            (0L, -1L, false),
            (0L, 0L, false),
            (long.MinValue, long.MinValue, false),
            (long.MaxValue, long.MaxValue, false)
        })
        {
            var signedStart = Block("entry", Array.Empty<CfgParameter>(), new[] {
                new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: a),
                new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: bValue),
                new CfgInstruction(2, CfgOpcode.LessThanI64, IrValueType.Bool,
                    Left: 0, Right: 1),
                new CfgInstruction(3, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 1),
                new CfgInstruction(4, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 0)
            }, new CfgBranch(2, "less", Array.Empty<int>(),
                "notless", Array.Empty<int>()));
            var signedGraph = new CfgFunction("signedlt", IrValueType.I64,
                "entry", new[] {
                    signedStart,
                    Block("less", Array.Empty<CfgParameter>(),
                        Array.Empty<CfgInstruction>(), new CfgReturn(3)),
                    Block("notless", Array.Empty<CfgParameter>(),
                        Array.Empty<CfgInstruction>(), new CfgReturn(4))
                });
            CheckCil(OresCfgVerifier.Verify(signedGraph), expected ? 1 : 0,
                "signed-less-than-boundary");
        }

        Reject(new CfgFunction("bad_lt_type", IrValueType.I64, "entry",
            new[] { Block("entry", Array.Empty<CfgParameter>(), new[] {
                new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 1),
                new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 2),
                new CfgInstruction(2, CfgOpcode.LessThanI64, IrValueType.I64,
                    Left: 0, Right: 1)
            }, new CfgReturn(2)) }), "less-than must return bool");

        // Real SSA loop: both i and total cross header/backedge block
        // parameters. The signed comparison determines the exit at i == 10.
        var sumEntry = Block("entry", Array.Empty<CfgParameter>(), new[] {
            new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                I64Constant: 0),
            new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                I64Constant: 0)
        }, new CfgJump("header", new[] { 0, 1 }));
        var sumHeader = Block("header", new[] {
            new CfgParameter(2, IrValueType.I64),
            new CfgParameter(3, IrValueType.I64)
        }, new[] {
            new CfgInstruction(4, CfgOpcode.ConstantI64, IrValueType.I64,
                I64Constant: 10),
            new CfgInstruction(5, CfgOpcode.LessThanI64, IrValueType.Bool,
                Left: 2, Right: 4)
        }, new CfgBranch(5, "body", new[] { 2, 3 },
            "exit", new[] { 3 }));
        var sumBody = Block("body", new[] {
            new CfgParameter(6, IrValueType.I64),
            new CfgParameter(7, IrValueType.I64)
        }, new[] {
            new CfgInstruction(8, CfgOpcode.CheckedAdd, IrValueType.I64,
                Left: 7, Right: 6),
            new CfgInstruction(9, CfgOpcode.ConstantI64, IrValueType.I64,
                I64Constant: 1),
            new CfgInstruction(10, CfgOpcode.CheckedAdd, IrValueType.I64,
                Left: 6, Right: 9)
        }, new CfgJump("header", new[] { 10, 8 }));
        var sumExit = Block("exit", new[] {
            new CfgParameter(11, IrValueType.I64)
        }, Array.Empty<CfgInstruction>(), new CfgReturn(11));
        var sumGraph = new CfgFunction("sum0to9", IrValueType.I64, "entry",
            new[] { sumEntry, sumHeader, sumBody, sumExit });
        CheckCil(OresCfgVerifier.Verify(sumGraph), 45,
            "signed-while-sum45");
        CheckCil(OresCfgVerifier.Verify(sumGraph with {
            Blocks = new[] { sumExit, sumBody, sumEntry, sumHeader }
        }), 45, "signed-while-sum45-reordered");

        // Type confusion and bogus payloads must fail before any CIL
        // emission, not silently reinterpret bools as signed integers.
        Reject(new CfgFunction("bad_lt_operand", IrValueType.I64, "entry",
            new[] { Block("entry", Array.Empty<CfgParameter>(), new[] {
                new CfgInstruction(0, CfgOpcode.ConstantBool, IrValueType.Bool,
                    BoolConstant: true),
                new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 3),
                new CfgInstruction(2, CfgOpcode.LessThanI64, IrValueType.Bool,
                    Left: 0, Right: 1)
            }, new CfgReturn(1)) }), "less-than rejects bool operand");
        Reject(new CfgFunction("bad_lt_payload", IrValueType.I64, "entry",
            new[] { Block("entry", Array.Empty<CfgParameter>(), new[] {
                new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 1),
                new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 2),
                new CfgInstruction(2, CfgOpcode.LessThanI64, IrValueType.Bool,
                    Left: 0, Right: 1, I64Constant: 0)
            }, new CfgReturn(1)) }), "less-than rejects extra immediate");

        // Loop-carried i64 value. Typed block parameters serve as SSA phi
        // arguments on the entry edge and the backedge.
        var entry = Block("entry", Array.Empty<CfgParameter>(),
            new[] {
                new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 0)
            }, new CfgJump("header", new[] { 0 }));

        var header = Block("header",
            new[] { new CfgParameter(1, IrValueType.I64) },
            new[] {
                new CfgInstruction(2, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 5),
                new CfgInstruction(3, CfgOpcode.EqualI64, IrValueType.Bool,
                    Left: 1, Right: 2)
            }, new CfgBranch(3, "exit", new[] { 1 }, "body", new[] { 1 }));

        var body = Block("body",
            new[] { new CfgParameter(4, IrValueType.I64) },
            new[] {
                new CfgInstruction(5, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 1),
                new CfgInstruction(6, CfgOpcode.CheckedAdd, IrValueType.I64,
                    Left: 4, Right: 5)
            }, new CfgJump("header", new[] { 6 }));

        var finish = Block("exit",
            new[] { new CfgParameter(7, IrValueType.I64) },
            Array.Empty<CfgInstruction>(), new CfgReturn(7));

        var loop = new CfgFunction("count", IrValueType.I64, "entry",
            new[] { entry, header, body, finish });
        var verifiedLoop = OresCfgVerifier.Verify(loop);
        Expect(CfgReferenceEvaluator.Evaluate(verifiedLoop) == 5,
            "loop-carried block parameter correctly increments to 5");
        CheckCil(verifiedLoop, 5, "loop");
        // Layout cannot be assumed to start with the entry block. The
        // emitter's explicit entry jump must work for arbitrary block order.
        CheckCil(OresCfgVerifier.Verify(loop with { Blocks = new[] {
            finish, body, entry, header
        } }), 5, "reordered-loop");


        bool exhausted = false;
        try
        {
            _ = CfgReferenceEvaluator.Evaluate(verifiedLoop, maxSteps: 2);
        }
        catch (InvalidOperationException ex) when (
            ex.Message == "CFG execution exceeded finite step budget")
        {
            exhausted = true;
        }
        Expect(exhausted, "reference evaluator enforces a finite step budget");

        // Diamond control flow: the join must read its own block parameter,
        // not a value from a predecessor which fails SSA dominance.
        var branchCondition = Block("entry", Array.Empty<CfgParameter>(),
            new[] {
                new CfgInstruction(0, CfgOpcode.ConstantBool, IrValueType.Bool,
                    BoolConstant: true),
                new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 10),
                new CfgInstruction(2, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 20)
            }, new CfgBranch(0, "left", new[] { 1 }, "right", new[] { 2 }));
        var left = Block("left",
            new[] { new CfgParameter(3, IrValueType.I64) },
            Array.Empty<CfgInstruction>(), new CfgJump("join", new[] { 3 }));
        var right = Block("right",
            new[] { new CfgParameter(4, IrValueType.I64) },
            Array.Empty<CfgInstruction>(), new CfgJump("join", new[] { 4 }));
        var join = Block("join",
            new[] { new CfgParameter(5, IrValueType.I64) },
            Array.Empty<CfgInstruction>(), new CfgReturn(5));
        var diamond = new CfgFunction("diamond", IrValueType.I64, "entry",
            new[] { branchCondition, left, right, join });
        Expect(CfgReferenceEvaluator.Evaluate(OresCfgVerifier.Verify(diamond)) == 10,
            "diamond passes typed values through join parameters");
        CheckCil(OresCfgVerifier.Verify(diamond), 10, "diamond");


        Reject(diamond with { Blocks = new[] {
            branchCondition, left, right, join with { Terminator = new CfgReturn(3) }
        } }, "predecessor-only SSA value does not dominate join");

        Reject(loop with { Blocks = new[] {
            entry, header, body, finish with { Terminator = new CfgReturn(6) }
        } }, "body-only definition does not dominate exit");

        Reject(loop with { Blocks = new[] {
            entry, header with { Terminator = new CfgBranch(1,
                "exit", new[] { 1 }, "body", new[] { 1 }) }, body, finish
        } }, "branch condition must be bool");

        Reject(loop with { Blocks = new[] {
            entry with { Terminator = new CfgJump("header", Array.Empty<int>()) },
            header, body, finish
        } }, "branch argument arity mismatch");

        Reject(loop with { Blocks = new[] {
            entry with { Terminator = new CfgJump("unknown", new[] { 0 }) },
            header, body, finish
        } }, "unknown target rejected");

        Reject(loop with { Blocks = new[] {
            entry with { Terminator = new CfgJump(null!, new[] { 0 }) },
            header, body, finish
        } }, "null jump target yields verifier rejection, not runtime exception");
        Reject(loop with { Blocks = new[] {
            entry with { Terminator = new CfgJump("header", null!) },
            header, body, finish
        } }, "null edge argument list rejected");
        Reject(loop with { Blocks = new[] {
            entry, header with { Terminator = new CfgBranch(3,
                "exit", new[] { 1 }, null!, new[] { 1 }) },
            body, finish
        } }, "null branch target yields verifier rejection");
        Reject(loop with { Blocks = new[] {
            entry, header with { Terminator = new CfgBranch(3,
                "exit", null!, "body", new[] { 1 }) },
            body, finish
        } }, "null conditional edge argument list rejected");


        Reject(diamond with { Blocks = new[] {
            branchCondition with { Terminator = new CfgBranch(0,
                "left", new[] { 0 }, "right", new[] { 2 }) },
            left, right, join
        } }, "edge argument must match destination block parameter type");

        Reject(diamond with { Blocks = new[] {
            branchCondition,
            left with { Terminator = new CfgJump("join", new[] { 4 }) },
            right, join
        } }, "edge argument cannot use a value defined in a sibling branch");

        Reject(loop with { Blocks = new[] {
            entry,
            header with { Instructions = new[] {
                new CfgInstruction(2, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 5),
                new CfgInstruction(3, CfgOpcode.EqualI64, IrValueType.Bool,
                    Left: 1, Right: 1, I64Constant: 7)
            } },
            body, finish
        } }, "binary arithmetic rejects extraneous literal payloads");

        Reject(loop with { Blocks = new[] {
            entry, header, body, finish with { Name = "header" }
        } }, "duplicate block name rejected");

        Reject(loop with { Blocks = new[] {
            entry with { Parameters = new[] { new CfgParameter(8, IrValueType.I64) } },
            header, body, finish
        } }, "entry requires no arguments");

        Reject(loop with { Blocks = new[] {
            entry, header, body, finish,
            Block("orphan", Array.Empty<CfgParameter>(),
                new[] { new CfgInstruction(8, CfgOpcode.ConstantI64,
                    IrValueType.I64, I64Constant: 99) }, new CfgReturn(8))
        } }, "unreachable block rejected");

        Reject(diamond with { Blocks = new[] {
            branchCondition, left, right,
            join with { Terminator = new CfgReturn(0) }
        } }, "return type mismatch bool vs i64");

        Reject(new CfgFunction("bad", IrValueType.I64, "entry",
            new[] { Block("entry", Array.Empty<CfgParameter>(),
                new[] {
                    new CfgInstruction(0, CfgOpcode.CheckedAdd,
                        IrValueType.I64, Left: 1, Right: 1),
                    new CfgInstruction(1, CfgOpcode.ConstantI64,
                        IrValueType.I64, I64Constant: 3)
                }, new CfgReturn(0))
            }), "same-block forward SSA reference rejected");

        Reject(new CfgFunction("bad", IrValueType.I64, "entry",
            new[] { Block("entry", Array.Empty<CfgParameter>(),
                new[] {
                    new CfgInstruction(0, (CfgOpcode)999, IrValueType.I64)
                }, new CfgReturn(0))
            }), "unknown opcodes fail closed");

        var huge = OresCfgVerifier.MaxValues + 1;
        Reject(new CfgFunction("oversizedBlocks", IrValueType.I64, "entry",
            new PoisonCountList<CfgBlock>(-1)),
            "negative declared CFG block counts reject before allocation");
        Reject(new CfgFunction("oversizedParams", IrValueType.I64, "entry",
            new[] {
                new CfgBlock("entry", new PoisonCountList<CfgParameter>(huge),
                    Array.Empty<CfgInstruction>(), new CfgReturn(0))
            }), "oversized parameters reject before ToArray");
        Reject(new CfgFunction("oversizedInstructions", IrValueType.I64, "entry",
            new[] {
                new CfgBlock("entry", Array.Empty<CfgParameter>(),
                    new PoisonCountList<CfgInstruction>(huge), new CfgReturn(0))
            }), "oversized instructions reject before ToArray");
        Reject(new CfgFunction("oversizedEdge", IrValueType.I64, "entry",
            new[] {
                new CfgBlock("entry", Array.Empty<CfgParameter>(),
                    Array.Empty<CfgInstruction>(),
                    new CfgJump("entry", new PoisonCountList<int>(huge)))
            }), "oversized edge rejects before ToArray");

        // The sum of individual *valid* collection sizes is separately bounded.
        // No SSA graph with this many requested definitions should be snapshotted.
        var nineThousand = Enumerable.Repeat(
            new CfgParameter(0, IrValueType.I64), 9_000).ToArray();
        Reject(new CfgFunction("totalValues", IrValueType.I64, "entry",
            new[] {
                new CfgBlock("entry", Array.Empty<CfgParameter>(),
                    Enumerable.Repeat(new CfgInstruction(0, CfgOpcode.ConstantI64,
                        IrValueType.I64, I64Constant: 0), 9_000).ToArray(),
                    new CfgReturn(0)),
                new CfgBlock("second", nineThousand, Array.Empty<CfgInstruction>(),
                    new CfgReturn(0))
            }), "sum of SSA definitions rejects before snapshot");
        var maxArguments = new int[OresCfgVerifier.MaxValues];
        Reject(new CfgFunction("totalEdges", IrValueType.I64, "entry",
            new[] {
                new CfgBlock("entry", Array.Empty<CfgParameter>(),
                    Array.Empty<CfgInstruction>(),
                    new CfgBranch(0, "next", maxArguments, "next", maxArguments)),
                new CfgBlock("next", Array.Empty<CfgParameter>(),
                    Array.Empty<CfgInstruction>(),
                    new CfgJump("entry", new[] { 0 }))
            }), "cumulative edge budget rejects before semantic verification");

        // Arithmetic instructions may trap even when their SSA result is unused.
        // A future optimizer must not silently delete such instructions.
        var unusedTrap = new CfgFunction("unusedTrap", IrValueType.I64, "entry",
            new[] { new CfgBlock("entry", Array.Empty<CfgParameter>(),
                new[] {
                    new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                        I64Constant: 1),
                    new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                        I64Constant: 0),
                    new CfgInstruction(2, CfgOpcode.CheckedDivide, IrValueType.I64,
                        Left: 0, Right: 1)
                }, new CfgReturn(0))
            });
        var verifiedTrap = OresCfgVerifier.Verify(unusedTrap);
        bool trapped = false;
        try
        {
            _ = CfgReferenceEvaluator.Evaluate(verifiedTrap);
        }
        catch (DivideByZeroException)
        {
            trapped = true;
        }
        Expect(trapped, "unused checked division still raises its observable trap");
        CheckCilTrap(verifiedTrap, true, "unused-divide-by-zero");

        // A backedge may exchange two parameters. The transfer must be
        // simultaneous, not sequentially overwriting the first source.
        var swap = new CfgFunction("swap", IrValueType.I64, "start",
            new[] {
                Block("start", Array.Empty<CfgParameter>(), new[] {
                    new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                        I64Constant: 11),
                    new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                        I64Constant: 22),
                    new CfgInstruction(2, CfgOpcode.ConstantBool, IrValueType.Bool,
                        BoolConstant: true)
                }, new CfgJump("loop", new[] { 0, 1, 2 })),
                Block("loop", new[] {
                    new CfgParameter(3, IrValueType.I64),
                    new CfgParameter(4, IrValueType.I64),
                    new CfgParameter(5, IrValueType.Bool)
                }, new[] {
                    new CfgInstruction(6, CfgOpcode.ConstantBool, IrValueType.Bool,
                        BoolConstant: false)
                }, new CfgBranch(5, "loop", new[] { 4, 3, 6 },
                    "finish", new[] { 3, 4 })),
                Block("finish", new[] {
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
        CheckCil(OresCfgVerifier.Verify(swap), 2211, "atomic-swap");
        // Three-way rotation on a self-edge proves that all predecessor
        // operands are captured before ANY destination parameter is updated.
        // A sequential transfer changes 3,1,2 into incorrect repeated values.
        var rotate = new CfgFunction("rotate", IrValueType.I64, "entry",
            new[] {
                Block("entry", Array.Empty<CfgParameter>(), new[] {
                    new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                        I64Constant: 1),
                    new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                        I64Constant: 2),
                    new CfgInstruction(2, CfgOpcode.ConstantI64, IrValueType.I64,
                        I64Constant: 3),
                    new CfgInstruction(3, CfgOpcode.ConstantBool, IrValueType.Bool,
                        BoolConstant: true)
                }, new CfgJump("loop", new[] { 0, 1, 2, 3 })),
                Block("loop", new[] {
                    new CfgParameter(4, IrValueType.I64),
                    new CfgParameter(5, IrValueType.I64),
                    new CfgParameter(6, IrValueType.I64),
                    new CfgParameter(7, IrValueType.Bool)
                }, new[] {
                    new CfgInstruction(8, CfgOpcode.ConstantBool, IrValueType.Bool,
                        BoolConstant: false)
                }, new CfgBranch(7, "loop", new[] { 6, 4, 5, 8 },
                    "finish", new[] { 4, 5, 6 })),
                Block("finish", new[] {
                    new CfgParameter(9, IrValueType.I64),
                    new CfgParameter(10, IrValueType.I64),
                    new CfgParameter(11, IrValueType.I64)
                }, new[] {
                    new CfgInstruction(12, CfgOpcode.ConstantI64, IrValueType.I64,
                        I64Constant: 100),
                    new CfgInstruction(13, CfgOpcode.CheckedMultiply, IrValueType.I64,
                        Left: 9, Right: 12),
                    new CfgInstruction(14, CfgOpcode.ConstantI64, IrValueType.I64,
                        I64Constant: 10),
                    new CfgInstruction(15, CfgOpcode.CheckedMultiply, IrValueType.I64,
                        Left: 10, Right: 14),
                    new CfgInstruction(16, CfgOpcode.CheckedAdd, IrValueType.I64,
                        Left: 13, Right: 15),
                    new CfgInstruction(17, CfgOpcode.CheckedAdd, IrValueType.I64,
                        Left: 16, Right: 11)
                }, new CfgReturn(17))
            });
        CheckCil(OresCfgVerifier.Verify(rotate), 312, "atomic-three-cycle");

        // A trap in a branch that is not selected must not execute. This
        // also checks that the CIL emitter has no accidental fallthrough.
        var conditionalTrap = new CfgFunction("chosen", IrValueType.I64, "entry",
            new[] {
                Block("entry", Array.Empty<CfgParameter>(), new[] {
                    new CfgInstruction(0, CfgOpcode.ConstantBool, IrValueType.Bool,
                        BoolConstant: true),
                    new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                        I64Constant: 42)
                }, new CfgBranch(0, "good", new[] { 1 },
                    "bad", new[] { 1 })),
                Block("good", new[] { new CfgParameter(2, IrValueType.I64) },
                    Array.Empty<CfgInstruction>(), new CfgReturn(2)),
                Block("bad", new[] { new CfgParameter(3, IrValueType.I64) },
                    new[] {
                        new CfgInstruction(4, CfgOpcode.ConstantI64, IrValueType.I64,
                            I64Constant: 0),
                        new CfgInstruction(5, CfgOpcode.CheckedDivide, IrValueType.I64,
                            Left: 3, Right: 4)
                    }, new CfgReturn(5))
            });
        CheckCil(OresCfgVerifier.Verify(conditionalTrap), 42,
            "untaken-trapping-branch");

        var overflow = new CfgFunction("overflow", IrValueType.I64, "entry",
            new[] { Block("entry", Array.Empty<CfgParameter>(), new[] {
                new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: long.MaxValue),
                new CfgInstruction(1, CfgOpcode.ConstantI64, IrValueType.I64,
                    I64Constant: 1),
                new CfgInstruction(2, CfgOpcode.CheckedAdd, IrValueType.I64,
                    Left: 0, Right: 1)
            }, new CfgReturn(2)) });
        CheckCilTrap(OresCfgVerifier.Verify(overflow), false, "checked-overflow");



        // Verified collections are deep frozen: modifying source parameters,
        // instructions or branch-argument lists does not alter the proof.
        var mutableArgs = new List<int> { 0 };
        var mutableOps = new List<CfgInstruction> {
            new(0, CfgOpcode.ConstantI64, IrValueType.I64, I64Constant: 42)
        };
        var mutableParams = new List<CfgParameter> {
            new(1, IrValueType.I64)
        };
        var mutable = new CfgFunction("immutable", IrValueType.I64, "start",
            new[] {
                new CfgBlock("start", Array.Empty<CfgParameter>(), mutableOps,
                    new CfgJump("end", mutableArgs)),
                new CfgBlock("end", mutableParams,
                    Array.Empty<CfgInstruction>(), new CfgReturn(1))
            });
        var approved = OresCfgVerifier.Verify(mutable);
        mutableArgs[0] = 999;
        mutableOps[0] = new CfgInstruction(0, CfgOpcode.ConstantI64,
            IrValueType.I64, I64Constant: -1);
        mutableParams[0] = new CfgParameter(1, IrValueType.Bool);
        Expect(CfgReferenceEvaluator.Evaluate(approved) == 42,
            "verified CFG is immune to mutable source aliases");

        DominanceOracleTests();
    }

    private static void CheckCil(VerifiedCfgFunction graph, long expected, string label)
    {
        string folder = Path.Combine(Path.GetTempPath(),
            "ores-cfg-cil-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            var output = Path.Combine(folder, "OresGenerated.dll");
            CilEmitter.EmitLibrary(graph, output);
            using var assembly = AssemblyDefinition.ReadAssembly(output);
            var entry = assembly.MainModule.Types.Single(t =>
                t.FullName == "Oreslang.Generated.OresProgram")
                .Methods.Single(m => m.Name == "Run");

            int signedOpCount = graph.Blocks.Sum(b =>
                b.Instructions.Count(op => op.Opcode == CfgOpcode.LessThanI64));
            if (signedOpCount != 0)
            {
                Expect(entry.Body.Instructions.Count(ins =>
                    ins.OpCode.Code == Mono.Cecil.Cil.Code.Clt) == signedOpCount,
                    label + ": signed less-than must emit exactly one clt per CFG op");
                Expect(!entry.Body.Instructions.Any(ins =>
                    ins.OpCode.Code == Mono.Cecil.Cil.Code.Clt_Un),
                    label + ": unsigned clt.un is forbidden for i64 less-than");
            }

            Expect(entry.Body.MaxStackSize == 2,
                label + ": emitted CFG stack bound");
            Expect(entry.Body.Variables.Count ==
                graph.Blocks.Sum(b => b.Instructions.Count + 2 * b.Parameters.Count),
                label + ": SSA and target-typed scratch locals");
            Expect(CfgReferenceEvaluator.Evaluate(graph) == expected,
                label + ": managed CFG reference result");
            Expect(CfgCilTestInterpreter.Evaluate(entry) == expected,
                label + ": emitted CIL agrees with reference CFG");

            var second = Path.Combine(folder, "OresGenerated.second.dll");
            CilEmitter.EmitLibrary(graph, second);
            Expect(File.ReadAllBytes(output).AsSpan().SequenceEqual(
                File.ReadAllBytes(second)), label + ": deterministic CIL PE");
        }
        finally
        {
            Directory.Delete(folder, true);
        }
    }

    private static void CheckCilTrap(VerifiedCfgFunction graph,
        bool divideByZero, string label)
    {
        string folder = Path.Combine(Path.GetTempPath(),
            "ores-cfg-trap-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            var output = Path.Combine(folder, "OresGenerated.dll");
            CilEmitter.EmitLibrary(graph, output);
            using var assembly = AssemblyDefinition.ReadAssembly(output);
            var entry = assembly.MainModule.Types.Single(t =>
                t.FullName == "Oreslang.Generated.OresProgram")
                .Methods.Single(m => m.Name == "Run");
            bool refTrapped = false;
            bool cilTrapped = false;
            try { _ = CfgReferenceEvaluator.Evaluate(graph); }
            catch (DivideByZeroException) when (divideByZero) { refTrapped = true; }
            catch (OverflowException) when (!divideByZero) { refTrapped = true; }
            try { _ = CfgCilTestInterpreter.Evaluate(entry); }
            catch (DivideByZeroException) when (divideByZero) { cilTrapped = true; }
            catch (OverflowException) when (!divideByZero) { cilTrapped = true; }
            Expect(refTrapped && cilTrapped, label + ": observable trap parity");
        }
        finally
        {
            Directory.Delete(folder, true);
        }
    }

    // Independently check the dominance decision against the graph-theoretic
    // definition: D dominates exit iff removing D makes exit unreachable
    // from entry. Enumerate graph shapes including diamonds and backedges,
    // always retaining a sequential edge to keep every block reachable.
    private static void DominanceOracleTests()
    {
        const int count = 5;
        for (int mask = 0; mask < 16; mask++)
        {
            var links = new (int First, int Second)[count - 1];
            links[0] = (1, (mask & 1) == 0 ? 2 : 4);
            links[1] = (2, (mask & 2) == 0 ? 4 : 0);
            links[2] = (3, (mask & 4) == 0 ? 4 : 0);
            links[3] = (4, (mask & 8) == 0 ? 4 : 0);

            for (int candidate = 0; candidate < count; candidate++)
            {
                var blocks = new CfgBlock[count];
                for (int i = 0; i < count; i++)
                {
                    CfgInstruction[] instructions = i == 0
                        ? new[] {
                            new CfgInstruction(0, CfgOpcode.ConstantI64, IrValueType.I64,
                                I64Constant: 100),
                            new CfgInstruction(count, CfgOpcode.ConstantBool,
                                IrValueType.Bool, BoolConstant: true)
                        }
                        : new[] {
                            new CfgInstruction(i, CfgOpcode.ConstantI64, IrValueType.I64,
                                I64Constant: 100 + i)
                        };
                    CfgTerminator terminator = i == count - 1
                        ? new CfgReturn(candidate)
                        : new CfgBranch(count, "b" + links[i].First,
                            Array.Empty<int>(), "b" + links[i].Second,
                            Array.Empty<int>());
                    blocks[i] = new CfgBlock("b" + i,
                        Array.Empty<CfgParameter>(), instructions, terminator);
                }

                bool accepted;
                try
                {
                    _ = OresCfgVerifier.Verify(new CfgFunction("oracle",
                        IrValueType.I64, "b0", blocks));
                    accepted = true;
                }
                catch (FormatException)
                {
                    accepted = false;
                }

                // Reachability from entry without passing through candidate.
                bool reachableWithoutCandidate = false;
                if (candidate != 0)
                {
                    var queue = new Queue<int>();
                    var visited = new bool[count];
                    visited[0] = true;
                    queue.Enqueue(0);
                    while (queue.Count != 0)
                    {
                        int from = queue.Dequeue();
                        if (from == count - 1)
                        {
                            reachableWithoutCandidate = true;
                            break;
                        }
                        foreach (int next in new[] { links[from].First, links[from].Second })
                        {
                            if (next != candidate && !visited[next])
                            {
                                visited[next] = true;
                                queue.Enqueue(next);
                            }
                        }
                    }
                }

                bool expectedAccepted = !reachableWithoutCandidate;
                Expect(accepted == expectedAccepted,
                    $"dominance oracle disagrees for graph {mask}, definition {candidate}");
            }
        }
    }
}
