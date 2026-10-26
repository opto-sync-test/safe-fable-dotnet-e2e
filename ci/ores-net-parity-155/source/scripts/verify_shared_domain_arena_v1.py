#!/usr/bin/env python3
import json
from pathlib import Path

CONTRACT_PATH = Path(__file__).resolve().parents[1] / "contracts" / "v1" / "shared_domain_arena_v1.json"
EXPECTED_BACKENDS = ("java", "llvm", "net", "wasm", "forge")
EXPECTED_LIFECYCLE = (
    "create-domain",
    "issue-control",
    "grant-membership",
    "critical-access",
    "logical-retire",
    "authority-revocation",
    "quiescence",
    "byte-scrub",
    "physical-reclamation",
)
EXPECTED_SOURCE_SEMANTICS = {
    "critical_read": "lexical-nonsuspending-read-lease",
    "critical_write": "lexical-nonsuspending-exclusive-lease",
    "guest_callback_while_locked": "forbidden",
    "busy_policy": "fail-fast-scheduler-retry",
    "rt_share": "unsupported-until-guest-lowering-and-source-conformance",
}
EXPECTED_CASES = {
    "domain-control-opaque": "deny-fabrication",
    "control-one-shot": "required",
    "foreign-control-denied": "deny",
    "stale-control-same-address-reuse-denied": "deny-stale",
    "actor-ref-not-domain-capability": "deny",
    "grant-binds-domain": "required",
    "grant-binds-actor": "required",
    "grant-binds-incarnation": "required",
    "read-permit-allows-read": "allow",
    "read-permit-denies-write": "deny",
    "write-permit-allows-read-write": "allow",
    "missing-permit-denied": "deny",
    "critical-read-nonsuspending": "required",
    "critical-write-nonsuspending": "required",
    "no-guest-callback-under-lock": "required",
    "critical-admission-nonparking": "required",
    "writer-conflict-is-busy": "retryable-busy",
    "reader-conflict-with-writer-is-busy": "retryable-busy",
    "revocation-monotonic": "required",
    "stale-grant-denied": "deny-stale",
    "handle-domain-fence": "deny-foreign",
    "handle-generation-fence": "deny-stale",
    "generation-never-wraps": "fail-closed",
    "lifetime-pin-no-byte-authority": "required",
    "lifetime-pin-off-carrier-release": "allow-release-only",
    "lifetime-pin-quota-bounded": "fail-closed",
    "retire-seals-new-authority": "required",
    "active-lease-delays-reclaim": "defer",
    "lifetime-pin-delays-reclaim": "defer",
    "failed-reclaim-remains-sealed": "required",
    "scrub-before-capacity-reuse": "required",
    "retirement-idempotent": "required",
    "rt-share-unsupported-until-guest-lowering": "unsupported",
    "scheduler-derived-actor-identity-required": "required",
    "guest-critical-lowering-needs-proof": "pending-evidence",
    "tenant-aggregate-quota-required": "required",
    "exact-head-runtime-evidence-required": "pending-evidence",
}

def _require(condition, message):
    if not condition:
        raise ValueError(message)

def validate(doc):
    _require(type(doc) is dict, "contract root must be object")
    _require(set(doc) == {
        "contract", "version", "status", "scope", "lifecycle_order",
        "source_semantics", "backend_support", "cases"
    }, "contract root fields differ")
    _require(doc["contract"] == "oreslang-shared-domain-arena-v1", "contract name differs")
    _require(doc["version"] == 1, "contract version differs")
    _require(doc["status"] == "source-free-contract-only", "contract status promoted")
    _require(type(doc["scope"]) is str and "no guest/runtime parity certification" in doc["scope"],
             "scope must remain non-certifying")
    _require(tuple(doc["lifecycle_order"]) == EXPECTED_LIFECYCLE, "lifecycle order differs")
    _require(doc["source_semantics"] == EXPECTED_SOURCE_SEMANTICS, "source semantics differ")

    support = doc["backend_support"]
    _require(type(support) is dict and tuple(support) == EXPECTED_BACKENDS, "backend set/order differs")
    expected_fields = {
        "host_shared_domain", "guest_critical_lowering", "rt_share", "exact_head_runtime_evidence"
    }
    for backend in EXPECTED_BACKENDS:
        row = support[backend]
        _require(type(row) is dict and set(row) == expected_fields, f"{backend} support fields differ")
        _require(row["guest_critical_lowering"] == "unsupported", f"{backend} guest lowering promoted")
        _require(row["rt_share"] == "unsupported", f"{backend} rt share promoted")
        _require(row["exact_head_runtime_evidence"] == "pending", f"{backend} runtime evidence promoted")
    _require(support["llvm"]["host_shared_domain"] == "candidate-host-prototype",
             "LLVM host prototype status differs")
    for backend in ("java", "net", "wasm", "forge"):
        _require(support[backend]["host_shared_domain"] == "unsupported",
                 f"{backend} host shared-domain support promoted")

    cases = doc["cases"]
    _require(type(cases) is list and len(cases) == len(EXPECTED_CASES), "case inventory differs")
    observed = {}
    for case in cases:
        _require(type(case) is dict and set(case) == {"id", "expect"}, "case fields differ")
        cid = case["id"]
        _require(type(cid) is str and cid not in observed, "case id missing or duplicated")
        observed[cid] = case["expect"]
    _require(observed == EXPECTED_CASES, "case expectations differ")
    return True

def load(path=CONTRACT_PATH):
    return json.loads(Path(path).read_text(encoding="utf-8"))

def main():
    validate(load())
    print(f"shared-domain arena v1 contract valid: {len(EXPECTED_CASES)} cases")

if __name__ == "__main__":
    main()
