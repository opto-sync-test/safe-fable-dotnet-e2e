# Oreslang .NET — Windows Native AOT backend

Independent **CIL compiler + .NET Native AOT runtime** for Oreslang. No LLVM, GraalVM, JIT, runtime CIL generation, or dynamic assembly loading is used by released binaries.

> **Status: bootstrap prototype, NOT the full Oreslang implementation.** Only a one-function checked signed-i64 arithmetic subset is implemented today. Native AOT compilation is required for distributed compiler and application artifacts.

## Native AOT pipeline

```text
Oreslang source (.ores)
    -> frontend (lexer, parser, AST)
    -> System.Reflection.Metadata CIL emission: OresGenerated.dll
    -> compile-time static reference from Ores.Net.NativeHost
    -> dotnet publish -c Release -r win-x64 (Native AOT)
    -> standalone oreslang-app.exe
```

Unlike managed .NET publishing, the final executable is compiled ahead of time by the .NET toolchain and does not require an installed .NET runtime. Dynamic compilation and JIT fallback are **not** permitted. For Windows Native AOT install the .NET 10 SDK and Visual Studio C++ build tools / Desktop development with C++ workload.

## Native build on Windows

~~~powershell
./scripts/publish-windows.ps1 -Source examples/hello.ores -Rid win-x64
./artifacts/apps/win-x64/oreslang-app.exe
# 14
~~~

This script **first publishes the compiler itself using Native AOT**, runs the native compiler to generate `OresGenerated.dll`, then publishes the statically linked application via Native AOT. The generated DLL is a build artifact, **not** dynamically loaded at runtime.

Manual version:

~~~powershell
dotnet publish compiler/Ores.Net.Compiler/Ores.Net.Compiler.csproj -c Release -r win-x64 -o artifacts/compiler/win-x64
./artifacts/compiler/win-x64/oresnet.exe compile examples/hello.ores --out artifacts/generated/OresGenerated.dll
$generated = (Resolve-Path artifacts/generated/OresGenerated.dll).Path
dotnet publish host/Ores.Net.NativeHost/Ores.Net.NativeHost.csproj -c Release -r win-x64 -o artifacts/apps/win-x64 "-p:GeneratedAssembly=$generated"
./artifacts/apps/win-x64/oreslang-app.exe
~~~

Windows ARM64 is a planned target: script accepts `-Rid win-arm64`, but CI coverage and compatible Windows ARM64 build infrastructure remain to be established.

## Current language support

The compiler accepts exactly this shape with optional `define`/`pub` modifiers:

~~~ores
define pub fnc main() : int {
    return 2 + 3 * 4;
}
~~~

Features: decimal signed 64-bit literals (including `-9223372036854775808`), parentheses, unary plus/minus, signed addition/subtraction/multiplication and checked overflow. Source division is rejected until float result lowering exists: reference Oreslang `int / int` returns `float`, so emitting integer CIL division would silently change semantics. Explicit internal checked-i64 IR division remains a separate tested primitive. The supported syntax is a deliberate **subset** and not the definitive shared Oreslang grammar. No variables, actor syntax, imports, general functions, typechecker, borrow checker or async/await yet.

### Component map

| Directory | Purpose |
| --- | --- |
| `compiler/Ores.Net.Compiler.Core` | Lexer/parser/AST and direct System.Reflection.Metadata CIL emission |
| `compiler/Ores.Net.Compiler` | Native AOT-compiled CLI (`oresnet`) |
| `host/Ores.Net.NativeHost` | Statically references generated CIL and Native AOT publishes it |
| `runtime/Ores.Net.Runtime` | AOT-compatible runtime API, bounded mailbox, unmanaged actor arenas, and AoS/SoA/AoSoA shard substrate |
| `verification/Ores.Net.Tests` | Parser/CIL metadata/mailbox tests (Mono.Cecil is test-only) |
| `scripts/` | Windows-only Native AOT publish pipeline |
| `docs/` | Backend contracts and implementation roadmap |

## Advisory static analysis facts (v0)

Two **non-executing** CLI modes now export `ores-static-facts/v0` JSON with
SHA-256 identity of admitted UTF-8 source, a canonical `__root__.main/0`
procedure, and no unproved security or actor claims:

- `oresnet static-facts file.ores` uses the **shipping** scalar parser,
  frozen typed/verified OresIR, and the same accepted subset as `check`.
- `oresnet static-facts-structured file.ores` uses the **experimental,
  non-production** typed structured parser. Its `while` statements are
  marked `exit=unknown` and `safepoint=false`. This mode does **not**
  establish executable CIL or full Native AOT parity.

Both reject unsupported effects and malformed source instead of inventing
proofs. See [`.NET static facts v0`](docs/STATIC_FACTS_V0_NET.md) for
limits, trust boundaries, format and CI verification.

## Experimental structured CFG parity path

Alongside the shipping scalar compiler, the managed verification harness now
contains a non-shipping structured-source path for typed `int`/`bool` locals,
assignments, `if`/`else`, `while`, early returns, equality and signed
less-than. `OresStructuredCfgLowering` lowers that bounded AST into the
existing verified SSA CFG and deterministic CIL emitter; differential tests
compare the CFG reference evaluator with emitted CIL.

This narrows semantic parity with the JavaScript and LLVM/Wasm backends, but it
does **not** change the shipping `oresnet check/compile` grammar, prove
cross-backend source-syntax identity, or establish Native AOT execution for the
current head. Promotion to the production CLI requires an exact-head managed
and Native AOT receipt plus review of the structured grammar against the shared
Oreslang frontend contract.

## Verification

~~~powershell
dotnet run --project verification/Ores.Net.Tests/Ores.Net.Tests.csproj -c Release
./scripts/publish-windows.ps1 -Source examples/hello.ores -Rid win-x64
~~~

Unit tests use a managed development-time test harness; this is **not part of the shipped compiler or application**. CI must publish both deliverables to native executables and execute the resulting Windows binary. The absence of a `.runtimeconfig.json` is a supplemental check; the successful Native AOT publish is the decisive proof. CI status must be checked before claiming working Windows artifacts.

**Runtime limitations:** This remains a bootstrap compiler and single-process actor runtime. .NET Native AOT still includes managed GC and CoreCLR does **not** intrinsically provide independently collected per-actor GC heaps. Oreslang now provides an explicit bounded unmanaged `ActorArena` substrate with persistent actor-private bytes, turn-scoped scratch, aggregate native-memory budgeting, suspension-safe read loans, lifetime-only pins, generation fencing, quiescent zeroize/free, and actor-owned AoS/SoA/AoSoA shards. General guest object allocation, ownership/borrow syntax, async-frame lowering, shared-domain arenas, native collections, and zero-managed-allocation steady-state execution are still pending and must fail closed. Actor references carry an internal random nonce in addition to ID/generation; these are **not authenticated distributed capabilities**. No in-process hot-code reload can rely on `Assembly.Load`; full code replacement requires process-generation rollout. See [actor arenas and layouts](docs/ACTOR_ARENAS_AND_LAYOUTS.md).

See [architecture](docs/architecture.md), [roadmap](docs/roadmap.md), [CI recovery runbook](docs/ci-recovery.md), and [security and verification](verification/README.md). This repository's license remains unspecified and should be chosen by its maintainers.

See [value-boundary audit and admission tests](docs/VALUE_BOUNDARIES.md) for
aggregate, call, string, conditional and async feature limits.

## Engineering policy: no Python

Python is prohibited in this repository and throughout the `ores-truffle-oreslang` organization for scripts, tests, CI helpers, code generators, analyzers, automation, and host tooling. Existing Python functionality must be migrated to **Rust** without weakening behavior, security checks, fixtures, or test coverage. Do not add `.py`, `.pyi`, `.ipynb`, Python dependency manifests, `python`/`python3` commands, `pip`, `pytest`, `poetry`, `uv`, or `actions/setup-python`. The .NET compiler/backend remains .NET/C#; the Python-to-Rust mandate applies to Python tooling rather than rewriting language-specific implementation code.
