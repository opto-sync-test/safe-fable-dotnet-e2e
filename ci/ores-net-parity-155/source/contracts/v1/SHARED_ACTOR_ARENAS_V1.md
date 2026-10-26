# Shared actor arenas v1 — cross-backend normative contract

Status: **proposed/runtime-integration pending** (2026-10-17). Applies to Java/GraalVM, LLVM, Wasm, Forge and .NET. Does not assert guest-language/compiler parity.

## Architecture

- Every actor incarnation (including a SHARED actor) owns a logically private **persistent arena** for its state and a **scratch arena** for turn-scoped temporaries. An ActorRef conveys mailbox authority, never arena access.
- SHARED is an **execution/communication domain**, not an exemption from ownership. Sharing data requires an **explicit domain-owned shared arena** and independently validated capability (`rt share` at source level once lowering exists).
- Share immutable frozen values by default. Mutable shared regions require capability-scoped synchronization (`critical-read`/`critical-write` or equivalent), not a raw pointer or unsynchronized alias. A shared arena is separate from an actor-local arena.
- Trusted host/code images and supervisor CONTROL state are not part of guest shared data. UNTRUSTED actors retain their per-actor logical arena inside the **single pooled untrusted Graal isolate**, without new per-actor isolates. Trusted and untrusted address spaces must not exchange pointers.

## State, authority and lifetimes

1. Create a unique arena/domain identity, nonzero actor incarnation, generation state and bounded byte/slot quotas. Charge budgets before allocation. Overflow and failed admission must not partially consume capability identity or accounting.
2. Persistent allocations outlive turns but not actor retirement. Scratch allocations are associated with the admitted turn and are invalidated and cleared on **every** turn exit, including exception, cancellation and suspend/cooperate. Suspending with scratch authority is rejected unless lowered into a separately lifetime-checked continuation allocation.
3. Every handle is opaque authority for one arena allocation. Implementations may internally use arena/domain ID, slot/offset, generation and incarnation, but callers must not be able to manufacture a live handle from those coordinates. Validate before every read/write/drop and reject foreign, stale, exhausted and out-of-bounds access. Copying, serializing, forwarding or otherwise transferring an opaque capability to another actor never grants private-arena authority unless an explicit sharing primitive creates separately validated shared authority.
4. Actor-local mutation requires its actor execution lease, even when a carrier migrates. Shared-data mutation requires the shared-region synchronization lease. Read leases exclude writes; write leases exclude all others.
5. **Logical retirement precedes physical reclamation.** Stop/retire first closes admission and revokes new turns, allocations, borrows and callback registrations. Once logical retirement starts, a late callback may release authority but must never reacquire actor memory authority or resurrect the arena.
6. Any continuation, persistent borrow, FFI operation or I/O callback that can outlive the actor turn must register a bounded **external lifetime pin/loan** before leaving the admitted turn. A lifetime pin grants no arena read/write authority by itself and may be released from the callback carrier.
7. Physical reclamation waits until active turns, continuations, borrows, external lifetime pins, shared-region leases, mailbox producer admissions, FFI work and I/O callbacks are quiescent. Releasing the last lifetime owner may trigger reclaim; release/close is idempotent and accounting must not underflow.
8. Drop nontrivial values exactly once in deterministic order before bulk reclaim. Zeroize confidential bytes on drop, teardown and before capacity reuse. Native/FFM/mmap resources require explicit release; Java/.NET finalizers and JavaScript GC are never correctness mechanisms.
9. A supervisor and child may hold shared-domain leases. Parent shutdown alone does not free a shared region; all members and leases must quiesce. Never hold a shared-region lock while invoking arbitrary guest callbacks.
10. Retirement is monotonic and retryable: a failed physical release must leave the arena logically retired and must not publish dirty/revived capacity. Identity and generation counters must never wrap back into live authority.
11. Snapshot, rollback and restore are new admissions, not time travel for capabilities: they may reconstruct validated values, but must not revive retired arenas, stale generations, consumed capability identities, outstanding borrows or pre-snapshot external pins.

## Backend mapping and honesty boundary

| Backend | Allocation substrate | Current quiescence substrate | Current honesty boundary |
| --- | --- | --- | --- |
| Java/GraalVM | Actor-owned FFM i64 regions plus managed wrapper/control objects | Persistent native `Loan` pins physical FFM release | Continuation/FFI/I/O registration wiring, general guest-value lowering, shared domains and exact-head Native Image evidence remain unverified |
| LLVM | Native actor slabs / compiled actor-owned i64 heap plus shared-domain host prototype | Native loan accounting and nonblocking destroy/retire paths | General object lowering, destructor coverage, callback wiring and exact-head sanitizer/AOT evidence remain unverified |
| Wasm | Runtime-owned bounded WebAssembly.Memory page pool with actor page leases | Opaque external lifetime lease delays page-pool reuse | Guest actor lowering, Worker/shared-domain integration and Wasmtime/AOT evidence remain unverified |
| Forge | Bounded C++ actor arena with opaque generational capabilities | Move-only external lifetime lease delays secure reclaim | Guest arena lowering, real FFI/I/O registration and exact-head CTest/sanitizer evidence remain unverified |
| .NET | Bounded unmanaged actor arena | Opaque external lifetime lease delays zeroize/free | Guest arena lowering, real continuation/FFI/I/O registration and Native AOT evidence remain unverified |

LLVM's compiler allocators are not automatically guest-state allocators. `Arena.ofShared()` means multi-thread-capable lifetime management, not unsynchronized shared mutation. Wasm linear memory is not an OS protection domain. Neither Java nor .NET may claim zero host GC merely because actor payload bytes are off-heap.

## Conformance gates before promoting to production

- Actor A cannot dereference actor B's private handle; ActorRef sharing grants no heap access.
- Persistent state survives turns/carrier migration; scratch survives neither turn exit nor suspension.
- Cross-arena replay, stale generations, wrong incarnation/carrier, fabricated coordinates and ABA are rejected.
- Quota is charged before allocation; failed admission/overflow is accounting-neutral and rejected construction does not consume capability identity.
- Cross-actor capability forwarding cannot smuggle private arena authority, and identity/generation exhaustion fails closed rather than wrapping into live authority.
- Snapshot/restore cannot resurrect retired or stale authority, outstanding borrows, consumed identities or external lifetime pins.
- Logical retirement denies all new authority before waiting for external quiescence.
- A continuation/borrow/FFI/I/O owner that outlives a turn must hold a lifetime pin; the pin itself cannot read or write arena memory.
- Late callbacks after retirement may release their pin but cannot allocate, open a turn, revive a handle or register another pin.
- Physical reuse/free cannot occur until the final lifetime owner, active turn and shared-domain lease are gone.
- Double release, simultaneous retire, callback/retire races and failed reclaim cannot underflow accounting or publish dirty capacity.
- Shared descendants and supervisor leases keep a shared domain alive after a parent actor stops.
- Test compiled Oreslang source on each backend, not only allocator host units. Add fuzz/property tests, ASan/UBSan for native paths, JVM Native Image and .NET Native AOT/GC allocation profiling.

## Suggested implementation order

First finish host-runtime lifetime pinning and quiescence; then wire continuation/FFI/I/O registrations into those pins; then lower actor persistent/scratch values and deterministic drops; then add shared-domain source lowering and cross-backend compiled-source conformance. Keep every unsupported case rejected.

Related tracked work includes the current Java actor-FFM, LLVM actor-heap/shared-arena, Wasm page-pool, Forge actor-arena and .NET unmanaged-arena drafts.
