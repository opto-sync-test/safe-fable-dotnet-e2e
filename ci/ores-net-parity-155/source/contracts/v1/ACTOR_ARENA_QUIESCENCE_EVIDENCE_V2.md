# Actor arena quiescence evidence matrix v2 (source-free only)

This contract is intentionally **not a compiler/runtime certification**.
It is shared byte-identically across the five source repositories and blocks
unsupported parity claims until authorized, executed, exact-source-head native
and guest tests are archived.

A supervisor may report physical `get_done()` only after all applicable
barriers in `actor_arena_quiescence_matrix_v2.json` have completed: no admitted
actor turns, no read loans, no external I/O/FFI continuation owners, no
in-flight routed-mail publication, no shared-domain grants pending
revocation, no unretired terminal CONTROL events, and no pending native
reclaim retry. Logical retirement must deny new authority before any physical
bytes are returned or published as reusable. Memory reuse must be scrubbed
and incarnation/generation fenced; callback carriers can **release lifetime
authority only** and may never dereference actor-owned memory.

An unavailable feature remains disabled/fail-closed, not silently counted as
passing its barrier. A bounded quiescence timeout must preserve dirty capacity
and report an explicit incomplete state; it must never force free an arena
with outstanding lifetime owners.

The `backends` section defaults to `NOT_VERIFIED` for source/native/AOT
execution because source-free validation cannot prove any of these modes.
To claim native parity, collect the exact PR head SHA + tree, source-owned
issuer-bound required check, nonzero executed job steps, architecture-specific
runtime fixtures and independent review. A zero-step Actions failure remains
`NOT_EXECUTED`; private compiler source must not be mirrored into an
unapproved organization to obtain runner minutes.

Run `python3 scripts/verify_actor_arena_quiescence_matrix_v2.py` and
`python3 scripts/test_actor_arena_quiescence_matrix_v2.py` to validate
the policy and rejection of weakened or fabricated certification claims.
