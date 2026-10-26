# Shared-domain arenas v1 — ownership, critical access, and quiescent retirement

Status: **source-free contract only**. Applies to Java/GraalVM, LLVM, .NET, Wasm, and Forge. It defines the semantics required before Oreslang may expose `rt share`; it does not certify any backend runtime.

## Domain ownership and authority

An explicitly shared arena is owned by a domain, not by an actor and not by an `ActorRef`. Domain CONTROL authority is a distinct opaque capability. Possessing an arena reference, domain ID, actor ID, or `ActorRef` is insufficient to add members, revoke members, or retire the domain.

Membership grants bind the domain, actor identity, actor incarnation, rights, and generation. CONTROL authority must also bind a globally non-recycling domain identity so a stale token cannot regain authority if a later arena reuses the same object address. Read rights permit only `critical-read`; write rights imply read and permit `critical-write`. Stale, foreign, revoked, wrong-incarnation, exhausted, or fabricated grants fail closed. Capability coordinates are not serializable guest values.

## `critical-read` / `critical-write`

`critical-read` is a lexical, non-suspending shared read lease. `critical-write` is a lexical, non-suspending exclusive lease. Admission must be non-parking: contention returns a retryable busy result to the scheduler rather than parking an actor carrier.

Neither critical scope may cross `await`, suspension, `rt cooperate`, actor turn exit, or arbitrary guest callback invocation. No guest callback runs while a shared-domain lock is held. A read lease cannot allocate, drop, or write. A write lease excludes all readers and writers while live.

## Lifetime-only pins

Continuations, FFI operations, and I/O callbacks that may outlive a critical section use a separate bounded lifetime pin. A lifetime pin confers no byte, handle, slot, read, write, allocate, or drop authority. It may be released by a completion carrier different from the acquirer. Release is idempotent.

Logical retirement seals new grants, critical leases, and pins immediately. Physical scrub/reclaim waits for all critical leases and lifetime pins to quiesce. Failed or incomplete reclaim never reopens authority. Scrub happens before capacity is published for reuse.

## Backend honesty boundary

LLVM currently has a trusted-host prototype. Java, .NET, Wasm, and Forge remain unsupported for host shared-domain arenas under this v1 contract. Guest `critical-read` / `critical-write` lowering and `rt share` remain unsupported on all five backends until source-level conformance exists. Exact-head native/runtime evidence remains pending everywhere.

## Promotion gates

Before `rt share` can be marked implemented, each backend must prove compiled Oreslang source for domain ownership, wrong-domain and wrong-incarnation rejection, read/write rights, non-parking contention, suspension rejection, lifetime-pin quiescence, deterministic scrub/reuse, quota accounting, stale-generation rejection, cancellation, and exact-head backend execution. Source-free contract success alone never promotes runtime support.
