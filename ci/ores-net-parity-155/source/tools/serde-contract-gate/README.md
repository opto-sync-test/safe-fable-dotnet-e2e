# Rust serde contract pin (static-only)

Run from the repository root:

```sh
cargo test --manifest-path tools/serde-contract-gate/Cargo.toml
cargo run --manifest-path tools/serde-contract-gate/Cargo.toml -- --root .
```

This gate replaces the Python static checker, pins the exact contract SHA-256,
and rechecks the fail-closed Sendable, Serializable, actor DATA, network codec,
and supervisor CONTROL policy shapes. It does not load a codec, compile
Oreslang source, or establish executable cross-backend parity. Changes to
the contract require an intentional version/hash review.
