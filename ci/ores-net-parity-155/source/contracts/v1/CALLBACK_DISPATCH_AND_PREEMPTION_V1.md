# Callback dispatch and preemption — v1 (no Zalgo)

Status: proposed normative cross-backend language contract; Java has partial executable coverage, native source lowering is incomplete. Host-runtime primitives alone do not constitute source-language parity.

## Core ordering guarantee

1. A guest-visible asynchronous operation may settle before its registration call returns, including a completed Future and foreign callback invoked synchronously by a host API. This *does not* authorize running its Oreslang continuation inline.
2. An asynchronous guest continuation must never execute while its registering guest frame or currently admitted actor handler is still executing. A completion thread may only atomically settle an operation, release internal accounting, or enqueue a bounded scheduler/mailbox ticket. Completion and registration may perform host-only, synchronous bookkeeping.
3. Every resumed guest continuation must enter through a fresh scheduler dispatch after the prior guest turn and its VM/Truffle/native execution boundary have unwound. It may reuse the same OS carrier after release, but must never reuse the prior dispatch identity, recursively invoke a guest callback, or replay committed source operations.
4. Actor guest work (receive, timers, HTTP ingress, async continuations, CONTROL, cleanup, and FFI callbacks) always acquires the actor's one physical execution lease. Other actors may run concurrently. One actor may not execute on two carriers simultaneously.
5. For a synchronous receive handler that internally yields solely for automatic CPU cooperation, the logical message remains admitted. No later user message for that actor may overtake its ready continuation. For a *genuinely pending* source await in a reentrant actor, other messages may run only according to its declared logical concurrency policy. A serial actor preserves logical exclusion across awaits.
6. Live mutable state loans and no-yield guards may not cross any suspension, including automatic preemption. A scheduler checkpoint alone cannot pretend to suspend an unlowered synchronous call or FFI frame.
7. Exactly one terminal outcome may win for each operation: success, error, timeout, cancellation, or close. Late callbacks cannot revive a stopped actor generation, repeat a continuation, or reclaim state before broker quiescence, guest cleanup and loan retirement. Rejected bounded admission must fail closed.

## Terminology

- A *guest callback* executes Oreslang source-owned logic, including transitive library and user handlers.
- A *host notification* is runtime-internal bookkeeping (e.g. a Future CAS, wait-list drain or mailbox publication). It may run inline, even for an already-settled Future, but it must not call guest code.
- *Physical preemption* releases a carrier at a continuation-safe point. This does not automatically permit a different message to enter the same actor.
- *Logical actor reentrancy* permits other messages during a truly pending await according to actor policy, but does not permit simultaneous actor execution.
- No global Node.js-style single-thread event loop is implied, nor does this guarantee callbacks from *different* actors are ordered by wall-clock return times.

## Observable conformance cases

| Case | Required assertion |
| --- | --- |
| Completed Future awaited in an active task | resumed source segment has a new dispatch id and cannot enter while the first segment is still running |
| Host registrar invokes resolve synchronously | the Future may already be settled on registrar return; guest continuation still runs in a fresh dispatch |
| Producer settles while handler is executing | producer does not run guest code; callback is mailbox-admitted after the handler's physical boundary exits |
| Completion between terminal fast-path inspection and waiter registration | at most one resume; no lost wakeup, no recursive guest execution |
| Cooperative synchronous receive with queued second message | the second message cannot overtake the ready continuation; committed operations are not replayed |
| Cancellation/timeout versus I/O success | one winner, no stale actor-generation execution and no premature frame retirement |
| Host scheduler/turn executor invokes callback twice or off-carrier | reject/terminate rather than silently granting a second actor execution lease |

## Source language/backend status

- Java/GraalVM: has scheduler-turn and actor-mailbox machinery and tests; these requirements still need adversarial integration and exact-tree CI for new changes.
- LLVM/native: completion gate, pinned continuation primitives and native cooperative carrier are *host runtime substrates*. Compiler-generated await/select guest continuations are not certified. Unsupported source must continue to fail closed.
- Wasm/.NET/Forge: bootstrap/scaffold/host prototypes do not claim source callback parity. New backends must implement this contract before advertising async actors.

## Required evidence to claim parity

Use the same supported .ores fixtures for each compiler, and record toolchain versions, exact Git tree IDs, native sanitizer results, scheduler callback/interleaving tests, negative compile diagnostics, and emitted artifacts. A host-only callback gate test is not a source-language conformance pass.
