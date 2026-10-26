#!/usr/bin/env python3
"""Fail-closed source-free validation for shared actor arena lifecycle v1."""
import json
from pathlib import Path
import sys

BACKENDS = ("java", "llvm", "net", "wasm", "forge")
STAGES = {
    "java": "candidate-host-runtime-ffm",
    "llvm": "candidate-compiled-i64-substrate",
    "net": "candidate-host-only-unmanaged",
    "wasm": "candidate-host-only-page-pool",
    "forge": "candidate-host-only-native-arena",
}
PIN_MODELS = {
    "java": "persistent-region-loan-prototype",
    "llvm": "native-loan-accounting-prototype",
    "net": "external-lifetime-lease-prototype",
    "wasm": "external-lifetime-lease-prototype",
    "forge": "external-lifetime-lease-prototype",
}
SHARED_DOMAIN = {
    "java": "unsupported",
    "llvm": "host-prototype-unverified",
    "net": "unsupported",
    "wasm": "unsupported",
    "forge": "unsupported",
}
INVARIANTS = (
    "actor-private-by-default",
    "actorref-never-grants-arena-access",
    "persistent-outlives-turn-not-retirement",
    "scratch-invalid-after-every-turn-exit",
    "stale-generation-and-wrong-incarnation-rejected",
    "no-guest-raw-pointer-or-memorysegment-exposure",
    "logical-retirement-revokes-new-authority-before-quiescence",
    "external-lifetime-pins-grant-no-memory-access",
    "continuation-borrow-ffi-io-owners-must-register-lifetime-pins",
    "physical-reclaim-waits-for-live-turns-borrows-and-external-pins",
    "late-callbacks-cannot-resurrect-retired-authority",
    "external-pin-release-is-idempotent",
    "shared-domain-reclaim-waits-for-members-and-leases",
    "reused-capacity-is-zeroized-before-admission",
    "retirement-is-monotonic-and-idempotent",
    "unsupported-shared-domain-or-general-lowering-fails-closed",
    "quota-charge-precedes-allocation-and-failed-admission-is-accounting-neutral",
    "rejected-construction-does-not-consume-capability-identity",
    "nontrivial-values-drop-exactly-once-before-bulk-reclaim",
    "identity-and-generation-counters-never-wrap-into-live-authority",
    "double-release-and-retire-races-cannot-underflow-accounting",
    "cross-actor-capability-transfer-never-grants-private-arena-authority",
    "snapshot-restore-cannot-revive-retired-or-stale-authority",
    "reclaim-failure-keeps-logical-retirement-and-dirty-capacity-unpublished",
)

class ContractError(ValueError):
    pass

def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ContractError("duplicate JSON key: " + key)
        out[key] = value
    return out

def validate_raw(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > 64 * 1024:
        raise ContractError("invalid actor-arena contract bytes")
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ContractError("BOM forbidden")
    try:
        doc = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs)
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ContractError("invalid canonical UTF-8 JSON") from exc
    validate(doc)
    return doc

def validate(doc):
    if type(doc) is not dict or set(doc) != {
        "contract", "version", "scope", "required_invariants", "backend_support"
    }:
        raise ContractError("unknown or missing top-level fields")
    if doc["contract"] != "oreslang-shared-actor-arenas-v1" or doc["version"] != 1:
        raise ContractError("contract identity/version mismatch")
    if doc["scope"] != (
        "source-free lifecycle/capability declarations; not guest runtime, compiler, AOT, callback-wiring, or zero-GC certification"
    ):
        raise ContractError("scope must not promote runtime certification")
    if doc["required_invariants"] != list(INVARIANTS):
        raise ContractError("actor-arena lifecycle invariants drifted")
    support = doc["backend_support"]
    if type(support) is not dict or set(support) != set(BACKENDS):
        raise ContractError("all five backends require explicit support declarations")
    required = {
        "candidate_stage", "general_guest_value_lowering", "shared_domain_arena",
        "lifetime_pin_model", "continuation_ffi_io_wiring",
        "zero_host_gc_certified", "native_aot_certified", "exact_head_ci_certified",
    }
    for backend in BACKENDS:
        row = support[backend]
        if type(row) is not dict or set(row) != required:
            raise ContractError("incomplete backend declaration: " + backend)
        if row["candidate_stage"] != STAGES[backend]:
            raise ContractError("candidate stage promotion/drift: " + backend)
        if row["general_guest_value_lowering"] != "unsupported":
            raise ContractError("general guest lowering promoted without proof: " + backend)
        if row["shared_domain_arena"] != SHARED_DOMAIN[backend]:
            raise ContractError("shared domain declaration drift: " + backend)
        if row["lifetime_pin_model"] != PIN_MODELS[backend]:
            raise ContractError("lifetime pin model drift: " + backend)
        if row["continuation_ffi_io_wiring"] != "unverified":
            raise ContractError("callback wiring promoted without proof: " + backend)
        for flag in ("zero_host_gc_certified", "native_aot_certified", "exact_head_ci_certified"):
            if row[flag] is not False:
                raise ContractError("unverified certification promoted: " + backend + "/" + flag)
    return doc

if __name__ == "__main__":
    path = Path(sys.argv[1]) if len(sys.argv) == 2 else (
        Path(__file__).resolve().parents[1] / "contracts/v1/actor_arena_lifecycle_v1.json"
    )
    try:
        validate_raw(path.read_bytes())
    except (OSError, ContractError) as exc:
        print("ACTOR_ARENA_LIFECYCLE_V1_DENIED: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
    print(
        "ACTOR_ARENA_LIFECYCLE_V1_PASS: "
        f"backends={len(BACKENDS)} invariants={len(INVARIANTS)} (source-free policy only)"
    )
