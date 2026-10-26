# Oreslang .NET — verified CFG-to-CIL lowering (draft)

**Status:** Implemented on a draft stacked branch. Compilation and native execution have **not** been verified. This work depends on [PR #3](https://github.com/ores-truffle-oreslang/oreslang-source.net/pull/3), which depends on [PR #2](https://github.com/ores-truffle-oreslang/oreslang-source.net/pull/2) and [PR #1](https://github.com/ores-truffle-oreslang/oreslang-source.net/pull/1).

## Implemented compiler path

`CilEmitter.EmitLibrary(VerifiedCfgFunction, ...)` delegates to `CfgCilEmitter`.
This entry point accepts *only verified CFGs*. The existing source-level
`oresnet compile` command continues to use verified straight-line arithmetic
OresIR; source-language branches and functions are **not yet supported**.

- `System.Reflection.Metadata` emits a static `OresProgram.Run(): i64`
  method, ready for build-time Native AOT compilation. No LLVM, Reflection.Emit,
  dynamic method loading, or runtime JIT is involved.
- Basic blocks receive labels before emission; a synthetic entry jump
  supports arbitrary physical block order. Every block has a terminating
  jump, conditional branch, or return. All CIL branches use long encodings
  and are resolved through `ControlFlowBuilder`.
- The local table allocates one typed local for each dense SSA result and a
  separate typed scratch local for each destination block parameter.
  `i64` uses an `int64` CIL local; `bool` uses a `bool` CIL local.
- A branch first copies **every** source edge operand into the destination's
  temporary scratch slots, then stores scratch values into the destination
  block parameter locals. This is the required simultaneous-assignment
  semantics for swaps, loop-carried values and shared incoming values.
  A true branch and false branch have separate edge transfer sequences.
- Each instruction immediately stores its CIL evaluation-stack result into
  its SSA local. The maximum stack depth is two for binary operations.
  All block entries and edge transfers have an empty evaluation stack.
- `add.ovf`, `sub.ovf`, `mul.ovf`, `div`, and `ceq` preserve checked-i64
  operations and equality. Operations execute even if their SSA result is
  unused: potentially trapping instructions are not DCE'd.
- CIL module IDs are derived from the **finalized method-body stream**
  (including resolved branch offsets) **and the local-variable signature bytes**.
  A signature token alone is insufficient: two builds could otherwise have
  the same token number but different `bool`/`i64` local layouts.
- The verifier caps CFG SSA definitions and scratch-local counts at 16,384
  each; the method has at most 32,768 local slots under this allocation scheme.
  Emission also rejects methods with more than 4 MiB of CIL before metadata
  serialization; all destination-parameter layouts are precomputed, avoiding
  repeated linear block lookups per branch edge.

## Differential verification fixtures

`CfgCilTestInterpreter` decodes the generated CIL using Mono.Cecil in the
**managed developer-test process**, never the Native AOT release process.
It compares results and exception types with the separate
`CfgReferenceEvaluator` on:

- A loop with a backedge, including an intentionally reordered block layout.
- A diamond conditional and typed join argument.
- A conditional that bypasses an exception-throwing branch.
- A backedge that swaps two parameters (correct answer **2211**; naive
  sequential copying would corrupt the swap), plus a separate three-way
  rotation of loop-carried values (correct answer **312**).
- An unused checked division by zero and a checked integer overflow.
- Stable byte-for-byte PE emission across repeated compilations.

The Windows workflow additionally generates a verified CFG CIL fixture in a
build-time-only managed project, publishes the *static* Oreslang host with
`dotnet publish -r win-x64` under the strict Native AOT guard, checks for
managed sidecars, and executes the native binary expecting **2211**.

The Linux diagnostic job now also invokes `verification/assert-linux-cfg-native.sh`:
it independently generates CIL in a fresh temporary directory, cleans and
publishes a **Native AOT** host under `linux-x64`, rejects managed sidecars,
checks its ELF executable, and executes the loop/atomic-swap fixture expecting
**2211**. This is additional cross-platform evidence, not permission to
release Windows binaries without passing the Windows job.

Both native fixture tests are **unverified until their respective runners
actually execute them**. A syntax-only shell test cannot substitute for a
successful `dotnet` build, generated metadata inspection, and native execution.

## Additional CFG and metadata hardening (2026-10-14)

- Both typed SSA and CFG CIL emitters now **explicitly** request the
  `InitLocals` method-body attribute, rather than relying on a library
  default. Mono.Cecil regressions inspect the resulting flag.
- Added `CfgCilStressTests` to the managed test entrypoint. It compares
  the independent CFG evaluator with the emitted CIL interpreter on
  condition-true, condition-false, and reordered-block variants with 640
  padding instructions, >255 local indexes and branch displacements that
  cannot be encoded in an 8-bit short form. It asserts actual branch
  displacement, typed locals and deterministic PE bytes.
- Added both truth values for the edge case where a conditional branch
  targets **the same successor block** with distinct arguments. The
  selected *edge* must determine the destination block-parameter values.
- A prior successful job in the private `canonical-cloud/canonical-e2e`
  repository demonstrated that hosted Actions steps worked there earlier
  that day, but a **new** no-source/no-checkout `dotnet --version` probe
  ([temporary PR #26](https://github.com/canonical-cloud/canonical-e2e/pull/26),
  [run 38682345558](https://github.com/canonical-cloud/canonical-e2e/actions/runs/38682345558))
  failed on Windows and Linux with zero reported steps. The PR was closed
  unmerged and its temporary workflow file deleted. This does not prove
  that billing minutes are exhausted; it means no current runner capacity
  could be verified. **No private Oreslang source was mirrored.**

## Long-branch regression correction and CI gating (2026-10-15)

- Corrected a **false-positive test requirement** in
  `verification/Ores.Net.Tests/CfgCilStressTests.cs`. The CFG emitter uses
  `brtrue` to skip just the short false-edge transfer sequence, not the
  entire 640-instruction block. The genuinely long jump is an
  **unconditional** `br` across the padding (or the synthetic entry jump
  for reordered blocks). The test now requires the conditional edge-select
  displacement to be at most 127 bytes and an actual unconditional
  branch displacement greater than 127 bytes. It still compares CIL
  interpretation to the independent CFG reference evaluator.
- The supported .NET metadata method-body API accepts
  `AddMethodBody(InstructionEncoder, maxStack, localVariablesSignature,
  attributes)` and resolves long-form branch labels when serializing
  the method. API signature inspection is **not a build or execution test**.
- A sixth private CI destination, `scintilla-run/scintilla-e2e`, had older
  successfully executed Actions, but its fresh **no-source** Windows/Linux
  `dotnet --info` probe ([temporary PR #18](https://github.com/scintilla-run/scintilla-e2e/pull/18),
  [run 38688393704](https://github.com/scintilla-run/scintilla-e2e/actions/runs/38688393704))
  failed with **zero reported executed steps** in both jobs. The probe
  workflow was deleted and the PR closed unmerged. No private Oreslang
  source was mirrored.
- The accountable administrative/release handoff is
  [Oreslang .NET issue #5](https://github.com/ores-truffle-oreslang/oreslang-source.net/issues/5).
  It requires source-organization runner diagnosis or authorized isolated
  Windows x64 .NET 10 execution, exact-head managed tests, strict Native
  AOT application execution and independent review **before merging**.

## Verification blockers and explicit non-goals

- GitHub Actions has repeatedly failed before returning job steps, including
  independent private runner-allocation probes across four organizations
  (3FA, gha-indie-worker, messaging-intel and akrion-sim). See
  [CI recovery and no-source probes](ci-recovery.md). **No alternative
  organization has a confirmed working runner**, so private source code
  was not mirrored out of the Oreslang organization.
- The local environment has no .NET SDK; C# compilation, tests and native
  execution on this branch are **unverified**.
- No source-level CFG parser, function calls, parameters or locals yet;
  no LLVM backend; no actor scheduler or ownership/effect verification.
- The reference interpreters are test scaffolding, not proof of arbitrary
  .NET or CIL semantics.
- Do not merge before the .NET 10 managed suite and real Windows Native AOT
  fixture succeed, and prerequisite PRs are merged in dependency order.

## Follow-ups

Resolve Actions runner allocation/billing/policy or use an authorized .NET 10
build host. Fix actual build diagnostics, then extend native tests with
additional CFG shapes and branch-boundary metadata inspection. After that,
add frontend control-flow constructs, source functions and locals, and a
liveness-aware local allocator without deleting trapping operations.
