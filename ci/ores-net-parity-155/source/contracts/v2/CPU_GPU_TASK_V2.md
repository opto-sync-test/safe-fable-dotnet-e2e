# Oreslang CPU/GPU task execution contract — v2

**Status (2026-10-20): normative source/runtime target.** This supersedes v1 spelling for new code without rewriting or invalidating pinned v1 evidence. Backends may remain fail-closed until their lowering/runtime gates are proved.

## Canonical source model

```ores
const T a = cpu { ... };            // synchronous CPU region
const T b = gpu { ... };            // synchronous GPU region

let Future<T> c = task { ... };     // default CPU task
let Future<T> d = cpu task { ... }; // explicit CPU task
let Future<T> e = gpu task { ... }; // explicit GPU task

const T x = await c;
const T y = await e;
```

- `cpu { ... }` and `gpu { ... }` are synchronous **from the caller's source semantics**: the expression completes with `T` (or `void`) before the caller proceeds.
- A synchronous region MUST NOT pin or block an OresVM carrier while physical CPU/GPU work is pending. The runtime may suspend the logical continuation and resume it later; this internal cooperation does not change the source result type into a Future.
- `task { ... }` is the default CPU task form. `cpu task { ... }` selects the CPU task domain explicitly. `gpu task { ... }` selects the GPU task domain.
- A task expression submits work immediately and returns exactly one `Future<T>` (or `Future<void>`). Calling `await` does **not** start the task.
- `await f` returns immediately when `f` is already complete; otherwise it suspends the current logical Oreslang task/continuation, releases its carrier, and makes that continuation runnable again after completion.
- `nb { ... }`, `nb cpu { ... }`, and `nb gpu { ... }` remain accepted compatibility aliases for `task { ... }`, `cpu task { ... }`, and `gpu task { ... }`. Formatter/lints SHOULD canonicalize new source to `task`.
- `task` is contextual, not a globally reserved identifier: only the task-block grammar consumes it.

Target grammar:

```ebnf
SyncDomainExpr = ("cpu" | "gpu") Block ;
TaskExpr       = ["cpu" | "gpu"] "task" Block
               | "nb" ["cpu" | "gpu"] Block ;  // compatibility
BlockResult    = FinalExpression | void ;
```

A no-value task has `Future<void>`. Oreslang does not invent a `Unit` value for empty/no-tail regions. A bare empty `gpu {}` or `gpu task {}` is rejected unless the block contains a meaningful validated device effect.

## Scheduler semantics

Oreslang uses many logical Tasks over bounded scheduler/carrier pools. Submission and waiting are distinct:

1. Evaluate/capture task inputs under normal ownership/effect rules.
2. Create the task/future and enqueue the task in its admitted scheduling domain.
3. Return the Future to the caller without waiting for a worker/device.
4. An available CPU carrier may start a CPU task **before the caller reaches `await`**.
5. A running CPU task executes until completion, a true suspension, cancellation/stop, explicit `rt yield`/`rt cooperate`, or a compiler/runtime safepoint that hands off the continuation.
6. Task continuations are logical; after a handoff they may resume on another permitted worker. No OS thread is created per task.
7. `await` only suspends the waiter when the dependency is incomplete. It is not the fairness mechanism and is not required for CPU-bound scheduling fairness.

Compiler-inserted resumable safepoints provide bounded cooperation independently of `await`, including at ordinary loop backedges and other proven-safe boundaries (for example selected calls, allocations, sends, and collection iteration). A handoff must save the Oreslang continuation, fully release the physical carrier, and later re-enqueue the same logical task. `Thread.yield()`/equivalents that keep guest execution pinned are not sufficient.

Synchronous collection/function APIs keep synchronous source types even if their continuation is internally split across scheduler turns.

## GPU task semantics

`gpu task { ... }` creates a host-owned task/future representing validated device work.

- Submission/admission may use a short host scheduling turn, but no carrier waits for device completion.
- Device completion is observed through a fence/event/provider callback and makes the waiting continuation runnable.
- Cancellation is a request, not proof that a dispatched kernel stopped. Buffer/loan/resource retirement waits for true device quiescence.
- No implicit CPU fallback, implicit host/device transfer, arbitrary CPU callback from a device kernel, or actor-carrier blocking is allowed.
- A synchronous `gpu { ... }` may use the same asynchronous device machinery internally, but hides the Future from source and suspends/resumes the logical caller until the result is available.

## Ownership, errors, nesting

Owned captures follow Oreslang move/borrow/share rules. Mutable loans may not outlive their permitted suspension/domain boundary unless the type/effect system proves that lifetime. Task failure completes its Future exactly once with the normal Oreslang error semantics; streaming remains an explicit bounded Channel/Stream concern.

CPU↔GPU lexical nesting lowers to a host-planned dependency graph with explicit fences/transfers. `gpu -> cpu` is a host continuation after a device fence, never a CPU callback executed once per GPU lane.

## Compatibility and release gates

v1 artifacts stay immutable as historical/pinned evidence. v2 adds the canonical `task` spelling and scheduler contract. A backend that has not implemented positive lowering MUST reject v2 execution forms before artifact publication with no host fallback. Positive support requires exact-source parser/type/lowering tests, CPU scheduler evidence, ownership/cancellation/quiescence tests, and real device evidence before claiming GPU execution.
