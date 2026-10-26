# .NET actor-owned arenas and data-oriented layouts

Status: **implemented host-runtime substrate; guest/compiler lowering pending**.

The .NET backend now has an explicit actor-private unmanaged memory substrate rather
than treating the CLR managed heap as the actor heap. This narrows the runtime gap
with the native LLVM heap and the GraalVM off-heap actor-region work without
claiming that CoreCLR itself exposes independently collected GC heaps.

## Memory model

Each `ActorArena` is bound to one logical actor ID and incarnation. Carrier
threads are deliberately not part of the authority model.

- **Aggregate budget** — each arena reserves its aligned persistent + scratch capacity against a runtime/process `ActorArenaBudget` before native allocation; failed admission is accounting-neutral and physical reclaim refunds exactly once.\n- **Persistent region** — native aligned storage that survives actor turns.
  Allocations use opaque arena/slot/generation capabilities. Partial frees never
  relocate live bytes; when the final allocation is dropped the persistent bump
  region is scrubbed and recycled.
- **Scratch region** — native turn-scoped bump storage. Every turn exit scrubs the
  used scratch prefix and invalidates all scratch capabilities by turn epoch.
- **Read loan** — may survive suspension and carrier migration. It prevents write
  and drop of its allocation, but cannot dereference bytes without a newly
  admitted owner turn.
- **Lifetime pin** — continuation/FFI/I/O lifetime only. It delays physical arena
  reclamation and intentionally has no read/write/handle API.
- **Retirement** — logical retirement seals new turns, allocations, loans and
  pins first. Physical zeroize/free waits for the active turn, read loans and
  lifetime pins to quiesce.

The runtime uses `NativeMemory.AlignedAlloc` / `AlignedFree`. Managed CLR
objects still exist for scheduler/control metadata and capability wrappers, so
this is not a claim of a zero-GC .NET process.

## Authority and ABA rules

Persistent capabilities carry an unexposed arena authority, actor identity,
incarnation, slot and slot generation. A default value is invalid. A capability
from another arena is rejected even when the numeric actor ID/incarnation match.
Dropping a slot increments its generation before reuse; generation exhaustion
fails closed rather than wrapping into live authority.

Scratch capabilities additionally carry the active turn epoch. A capability from
a previous turn cannot address newly reused scratch bytes.

The runtime never exposes a raw native pointer to guest-facing callers.

## Data-oriented storage

`ActorShardColumns` stores one homogeneous dense double region in exactly one
authoritative physical layout:

- `Aos`: row-major Array of Structures style.
- `Soa`: field-major Structure of Arrays style.
- `Aosoa`: power-of-two tiled Array of Structures of Arrays style, up to 1024
  lanes per tile.

AoSoA pads the physical row count without changing logical row bounds. Shards are
limited to 16 MiB and are charged to the owning actor arena. Column copies target
caller-provided spans so the API does not create unmetered detached snapshots.

This is the first .NET storage substrate for future `define inverted class`,
`InvertedArray<T>`, ECS/archetype tables and DOP kernels. The compiler must
choose one authoritative physical layout rather than maintaining synchronized
AoS/SoA/AoSoA copies.

## Current parity boundary

Implemented in this slice:

1. Per-actor unmanaged persistent and scratch storage plus aggregate native-memory reservation.
2. Single physical turn admission per actor arena.
3. Generation/incarnation/arena authority fencing.
4. Read loans across suspension with mutation/drop exclusion.
5. Lifetime-only continuation/FFI/I/O pins.
6. Logical retirement before quiescent physical reclamation.
7. Scrub-before-reuse and scrub-before-free.
8. AoS, SoA and AoSoA actor-owned shard addressing.
9. Allocation-free column copy and a dense reference integration kernel.
10. Native-AOT-compatible static APIs with no reflection or dynamic loading.

Still deliberately unsupported/fail-closed:

- General Oreslang object/class allocation lowering into `ActorArena`.
- Source `rt take`, `rt copy`, `rt share`, `rt borrow`, and
  `rt mut borrow` lowering.
- Mutable loans across suspension.
- `define inverted class` / `InvertedArray<T>` source lowering.
- Shared-domain arenas and guest `critical-read` / `critical-write`.
- Compiler-generated async continuation frames stored in actor native memory.
- Deterministic drop tables for nontrivial guest values.
- Native collection/string implementations and zero-managed-allocation
  steady-state actor execution.
- Typed GPU/OpenCL lowering from these layouts.

Until those compiler/runtime integrations have source-level conformance tests,
the backend must continue rejecting unsupported syntax rather than lowering it
to CLR object allocation or silently changing ownership semantics.

## Verification

`ActorArenaSelfTest` exercises persistent/scratch lifetime, stale generation
replay, same-ID cross-arena denial, suspension loans, off-carrier release,
retirement ordering, quota refund and scrubbed reuse.

`ActorShardColumnsSelfTest` runs identical logical values through AoS, SoA and
AoSoA layouts, verifies tiled padding and dense integration, bounds checks, and
deterministic release back to the actor arena.

The repository's Windows Native AOT workflow remains the authoritative build
gate for this implementation.
