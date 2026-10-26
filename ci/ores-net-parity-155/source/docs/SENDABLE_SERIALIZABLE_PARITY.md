# Oreslang Sendable / Serializable v1 — five-backend parity gates

**Security contract:** `contracts/v1/serde_boundary_v1.json` (identical Git blob in `.java`, `.llvm`, `.net`, `.wasm`, `.forge` working branches).

A shared contract file proves specification alignment **only**. Do not report runtime parity until exact-head compiler, ownership, data transport, CONTROL isolation and cross-wire executable tests pass.

## Independent proofs, not interchangeable words

1. **`Sendable<T>`:** sealed/compiler-proven, recursively checked ownership and lifetime for actor DATA. Does not imply network serialization or shared mutation.
2. **`Serializable<T, Format>`:** pure bounded encoder and owned decoder for a pinned format/schema. Does not grant mailbox authority, IO permissions, or move rights.
3. **`ActorMessageCodec<T>`:** compiler/runtime-pinned actor DATA codec; users cannot provide mailbox schema IDs, select runtime decoder by incoming bytes or send codec objects as messages.
4. **`NetworkCodec<T, Format>`:** explicit JSON/MessagePack v2/Protobuf data conversions, with independent network permissions.
5. **Supervisor CONTROL:** runtime-minted, target/incarnation-scoped separate channel. No control authority may be serialized or nested in DATA.

For moved values, mailbox admission must be atomic: failure preserves ownership and quota accounting. Snapshot bytes must not alias mutable sender data. Reject unknown shapes, borrowed values, pointers, capabilities, nominally spoofed imports, unsupported tagged unions and unauthenticated remote envelopes.

## Current implementation inventory, NOT parity certification

| Backend | Implemented starting point | Still blocking full parity |
| --- | --- | --- |
| Java/GraalVM | Source actor boundary hardening; draft compiler-owned descriptor registry; legacy actor runtime and standalone MessagePack testing | Actual registered derived codecs, tagged Option/Result, exact width type IR, DATA/CONTROL integration, Native Image execution |
| LLVM | Native i64 actor sends and ownership checks; standalone native MessagePack v2 tests | Typed schema/codec lowering for source actor send, external JSON/Protobuf, complete ownership and supervisor DATA/CONTROL |
| .NET | Copy-on-send bounded local byte mailbox, non-public nonce-minted ActorRef, stale-generation checks | Source Sendable/Serializable lowering, external codecs, authenticated remote DATA, supervisor CONTROL and Native AOT checks |
| Forge | Copy-on-send bounded local byte mailbox; hardening branch adds private identity to prevent same-ID mailbox spoofing | Source Sendable/Serializable lowering, typed wire codec, remote authentication, supervisor CONTROL |
| Wasm | Pure scalar guest, exactly zero host imports | No actor runtime or network IO. Remain fail-closed; do not synthesize actor/channel features with host imports |

The Java `PortableCodecRegistry` fingerprint is explicitly not the established MessagePack v2 actor shape digest, and neither digest is an authentication MAC.

## Release qualification (all five)

- Compile actual source through its backend. Execute positive data/control tests, not just rejection parsers or model-only tests.
- Negative corpus: direct/nested ActorRef, control/group permit, codec object, borrow, unsafe pointer, width/shape confusion, malformed UTF-8, noncanonical bytes, oversize/depth, missing permission, unsupported Option/Result.
- Cross-backend golden byte vectors for every claimed interoperable MessagePack/JSON/Protobuf profile, including mismatched schema/version and replay.
- Real mailbox stage/rollback and cancellation/stop/teardown, mutation races, generation rotation, copy vs move, zero shared writable alias.
- ASan/UBSan on native C++ paths, Maven/JUnit plus Graal native-image, .NET Native AOT, actual Wasm guests, and independent source/actor runtime execution at exact Git SHAs.
- A job failing before its first step **is not a test result**. Unsupported backends must report unsupported, not passing parity.

**Do not merge a parity-certification claim** until a machine-readable per-backend result includes the exact source commit, compiler/toolchain, executed test count and gaps. The shared JSON contract does not automatically certify any backend.
