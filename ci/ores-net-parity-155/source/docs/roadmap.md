# Engineering milestones

### N0 — Buildable bootstrap (this PR)
Strict AOT compiler and host project files; direct CIL emission for checked i64 constant/compound expressions; static host entry; mailbox prototype; Windows x64 pipeline; unit tests.

### N1 — Normative Oreslang frontend
Port/shared grammar corpus, identifiers, typed AST, scope graph, parser diagnostics, aliases, records, structs, ADTs, enum types, named/default type args and module visibility. `define pub` canonical formatter stays shared.

### N2 — Typed and verified OresIR
CFG, SSA, ownership/borrow moves, non-null contracts, generic instantiation closure, symbols, traps, errors, match/switch/select and alias-expansion cycles; verify before lowering.

### N3 — Native AOT-aware CIL lowering
General functions, calls, locals, loops, structs, records, exhaustive generic specialization, interop metadata, checked arithmetic, exceptions and full stack traces where permitted. Build-time trim manifest and diagnostics for unsupported dynamic features.

### N4 — Actor runtime contract
Four scheduler domains, CONTROL coordinator, bounded mailboxes, typed ActorRef, supervision, send acknowledgements, actor-owned arenas where safe, stable Result serialization and generation-aware transport.

### N5 — Async and cross-generation upgrades
`await`, `select`, `*_blocking` cooperative suspension without blocking scheduler threads; process-level staged native-generation replacement and rollback (no runtime code loading).

### N6 — Parity, proofs and release
Differential conformance with Java/LLVM/Forge, fuzzing and formal models of ownership and mailbox linearizability, release signing/SBOM, win-x64+win-arm64 production matrix, constrained resource tests.

**Do not mark any milestone complete without reproducible CI evidence.**
