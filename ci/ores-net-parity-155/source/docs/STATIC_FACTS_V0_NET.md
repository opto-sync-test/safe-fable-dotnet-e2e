# .NET static facts v0 — first backend-neutral analysis bridge

Status: **experimental and advisory; never a Native AOT, zero-GC, termination, actor, callback, or security admission certificate**.

Two deliberately distinct commands share the format in [`oreslang-common-source` draft PR #106](https://github.com/ores-truffle-oreslang/oreslang-common-source/pull/106). The limited JSON facts can be inspected by the restricted Rust importer in [`oreslang-static-analysis.rs` draft PR #16](https://github.com/ores-truffle-oreslang/oreslang-static-analysis.rs/pull/16), but the producer's SHA256 field is a source identity, **not an attestation**.

## Current source pipelines

```text
oresnet static-facts scalar.ores
    => OresParser.Parse (shipping i64 subset)
    => OresIrLowering.Lower (frozen and verified OresIR)
    => ores-static-facts/v0 JSON

oresnet static-facts-structured structured.ores
    => OresStructuredParser.Parse (independent typed experimental subset)
    => conservative AST loop extraction
    => ores-static-facts/v0 JSON
```

`static-facts` accepts exactly the same single `main` checked signed-i64 expression programs as the shipping `check` and `compile` commands. It emits one `__root__.main/0` function, no loops and no call edges. Calls, actor spawning, `nb` Tasks, dynamic dispatch, foreign calls, async/await, callbacks and ownership constructs cannot enter this compiler path.

`static-facts-structured` is **not** the shipping CIL path. Its separately verified syntax parser currently supports one `main():int` with scalar expressions, mutable locals, `if/else`, and `while`. All loops are emitted with `exit=unknown`, `safepoint=false`; it does not prove that loop termination can be decided or that a cooperating scheduler exists. No structural source effect may be silently converted to production CIL.

Both modes reject source beyond the 1 MiB bootstrap UTF-8 budget, malformed source, NULs, invalid Unicode, and BOM-bearing files in analysis mode. Rejecting BOM avoids signing decoded/modified text while silently dropping original bytes. The `unit` field is `sha256:` followed by lower-case hexadecimal SHA-256 of the **exact admitted UTF-8 source**.

## Wire contract

Output uses `ores-static-facts/v0`, with `unit`, `procedures`, `edges`, `taint_sources`, `flows`, `sinks`, and `permission_checks`. The first .NET source subset emits exactly one procedure and no edges or security/callback facts. Empty arrays **do not attest general safety**; they mean that those operations cannot be expressed by the admitted sublanguage.

This producer is capped by Rust's consumer constraints: up to 512 procedures, 256 loops/procedure, 4,096 loops across the document, 8,192 call edges, and 128 AST traversal depth. The *current* .NET grammar emits exactly one procedure and zero calls. Large or deeply nested AST inputs fail closed; the analyzer cannot mistake absence of an unsupported effect for a complete whole-language proof.

There are no verified source spans in this v0 JSON. The structured parser contains source offsets, but emitting them as certified cross-backend diagnostic spans before CFG/callsite mapping would overstate their provenance.

## Verification

```pwsh
dotnet run --project verification/Ores.Net.Tests/Ores.Net.Tests.csproj -c Release
dotnet build compiler/Ores.Net.Compiler/Ores.Net.Compiler.csproj -c Release
./verification/assert-static-facts-v0.ps1
python3 scripts/verify_net_static_facts_v0.py
```

Both the .NET verifier harness and the `Windows Native AOT` GitHub Actions workflow include static-facts tests. The `linux-aot-diagnostic` job also runs `verify_net_static_facts_v0.py` against the *actual* managed .NET CLI (not a fixture-only model), checking exact source-byte identity, v0 wire shape, unknown loops, unsupported source syntax and strict-profile rejection. These test signed-i64 admission and rejection, JSON determinism and SHA-256 identity, structured-loop unproved semantics, unsupported calls/characters, budget failures, CLI strict-profile rejection, and an exact-byte BOM negative case.

**Do not claim green CI or actual Native AOT parity until the exact PR head's hosted Windows workflow executes its steps successfully.** At the time of authoring, historical Actions runs on this private organization have often failed without executing test steps; source code and tests checked into GitHub are not runtime evidence. Private source cannot be sent to an alternate GitHub organization by bypassing a connector-level security restriction.

## Remaining parity work

1. Unify `OresStructuredParser` and the shipping compiled path behind a single verified typed CFG and CIL admission gate, or keep the structured exporter explicitly experimental.
2. Support interprocedural calls with unique callsite IDs, enclosing-loop effects, bounded recursion/SCC proofs and source-spanned diagnostics.
3. Export actor `spawn`, `nb` Task spawn, mailbox fanout, supervisor restart, cancellation and quiescence with trusted effect metadata; no fake actor heap isolation (managed Native AOT includes GC).
4. Add callback Zalgo timing, completed subscription installation, borrow/across-`await` ownership effects, capability ceilings and security taint only after actual compiler parsing and verified lowerings exist.
5. Prove that Rust advisory importer agrees on exact `.ores` inputs, then implement per-backend conformance tests with real executed Windows Native AOT binaries.
