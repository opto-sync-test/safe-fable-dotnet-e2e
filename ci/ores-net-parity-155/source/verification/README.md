# Security and verification checklist

## Implemented tests
- Parse precedence, modifiers, signed minimum and malformed input rejection.
- Emitted CIL metadata: public static i64 `Run`; uses checked addition and multiplication.
- Mailbox byte-copy isolation, queue limits, wrong ID/old generation rejection, stop/restart.
- Error exit mapping: overflow and divide by zero.
- Windows CI: planned real Native AOT publish of compiler and application and execute .exe.

## Required before production
- Parser/AST fuzzing with byte and recursion-depth budgets and shrinking regressions.
- Static analyzer gate for `IL2xxx` trimming and `IL3xxx` AOT warnings; no unreviewed suppression.
- Verify all published assemblies are reachable through static call graphs; no runtime codegen.
- Differential conformance with existing GraalVM, LLVM and Forge backends.
- Message serialization fuzzing, actor generation replay and capability forgery testing.
- Model check linearizability of concurrent Send/TryReceive/Restart/Stop.
- Windows ARM64 Native AOT execution on appropriate native hardware.
- Runtime-failure and supervisor propagation, structured errors, trace redaction policy.
- Multi-process replacement choreography for strict-AOT hot upgrades.
- Resource, allocation/GC pressure and denial-of-service limits.

**Current mailbox is not proven actor-private memory isolation.** Runtime-managed objects still reside on the .NET managed heap; only message bytes are copied.
