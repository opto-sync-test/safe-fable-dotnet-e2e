# Native AOT audit follow-up — 2026-10-14

Scope: [draft PR #1](https://github.com/ores-truffle-oreslang/oreslang-source.net/pull/1).

## Defects fixed in this pass

1. **Command-line argument crash:** `oresnet compile source.ores` passed the old mixed shape guard and dereferenced `args[3]`. The CLI now accepts exactly `check <source>` and `compile <source> --out <OresGenerated.dll>`, rejecting every other combination with exit code 2 before indexing.
2. **Native compiler negative tests:** Added `verification/assert-native-compiler-cli.ps1`, covering missing arguments, unknown flags, malformed UTF-8, >1 MiB source, invalid syntax, no partial assembly creation, valid check and valid CIL emission. Windows CI runs it against the **published Native AOT compiler executable**, not just the managed developer harness.
3. **Mailbox identity/capability collision:** The prototype used public numeric `(Id, Generation)` references. Two independently instantiated mailboxes with identical IDs and generations could accept each other's references. A reference now has an internal random nonce; it is bound to one mailbox instance and rotates on restart. The test suite checks matching-ID cross-mailbox rejection and nonce omission from `ToString()`.

## Scope and limitations

- The nonce is an **in-process prototype capability**, not a cryptographically authenticated network token. This does not establish actor heap isolation, tenant isolation, or formal linearizability.
- The compiler is still a strict **build-time CIL emitter**, not a runtime JIT, dynamic loader, or complete Oreslang frontend.
- No build success is inferred from pushing test code or from a GitHub job with no executed steps. The release gate remains **successful Windows x64 Native AOT publication and actual executable execution**.
- Native AOT still uses .NET GC and cannot offer Java/Graal-style hot runtime assembly loading; generation upgrades need separately compiled native processes.

## Outstanding hardening

- Restore GitHub Actions runner execution and obtain real compiler / linker output.
- Run native CLI negative tests, metadata/PE tests, 2,048-operand AST regression, and mailbox concurrency tests.
- Differential native evaluation of checked overflow and division by zero, including the `long.MinValue / -1` case.
- Move ActorRef to a typed capability with provenance metadata and a signed wire envelope before cross-process routing; model-check send/receive/restart safety.
- Verify Windows Arm64 on a compatible runner and document AOT trimming errors as part of release.
