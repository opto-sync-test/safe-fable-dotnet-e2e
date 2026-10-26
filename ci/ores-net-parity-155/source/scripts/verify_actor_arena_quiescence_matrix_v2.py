#!/usr/bin/env python3
"""Fail-closed source-free policy gate; never certifies native actor runtimes."""
import json
import sys
from pathlib import Path

BARRIERS = ["single-flight-per-actor","bounded-mailbox-and-memory-credit","authenticated-data-control-separation","logical-revocation-before-reclaim","physical-turn-quiescence","read-loan-quiescence","external-continuation-lease-quiescence","shared-domain-membership-quiescence","routed-mail-publication-and-retirement","stop-cancel-terminal-drain","retryable-partial-physical-cleanup","generation-incarnation-aba-fence","zeroization-before-capacity-reuse","cross-carrier-release-no-guest-dereference","failure-reason-observability","exact-head-native-evidence"]
BACKENDS = ("java", "llvm", "net", "wasm", "forge")
STATUS = {
    "host_substrate": "PRESENT_UNCERTIFIED",
    "source_actor_execution": "NOT_VERIFIED",
    "native_execution": "NOT_VERIFIED",
    "native_aot": "NOT_VERIFIED",
    "source_local_run": "NOT_EXECUTED",
    "live_streams_and_callbacks": "NOT_VERIFIED",
}
EVIDENCE = (
    "exact_pr_head_and_git_tree", "issuer_bound_required_check",
    "authorized_source_local_runner",
    "adversarial_actor_lifecycle_fixtures", "independent_code_review",
    "pass_failure_artifact_manifest",
)

def verify(data):
    if not isinstance(data, dict):
        raise ValueError("matrix must be an object")
    if data.get("schema") != "oreslang.actor_arena_quiescence_evidence.v2" or data.get("revision") != 2:
        raise ValueError("unrecognized matrix revision")
    if data.get("source_free_policy_only") is not True:
        raise ValueError("policy material cannot claim runtime certification")
    if data.get("never_export_private_source_to_unapproved_org") is not True:
        raise ValueError("private source export is not authorized")
    observed = data.get("required_barriers")
    if not isinstance(observed, list) or observed != BARRIERS or len(set(observed)) != len(BARRIERS):
        raise ValueError("missing/reordered/duplicated actor quiescence requirement")
    evidence = data.get("mandatory_native_evidence")
    if not isinstance(evidence, dict):
        raise ValueError("native evidence gate missing")
    for key in EVIDENCE:
        if evidence.get(key) is not True:
            raise ValueError("mandatory native evidence removed: " + key)
    if type(evidence.get("minimum_executed_job_steps")) is not int or evidence["minimum_executed_job_steps"] < 1:
        raise ValueError("zero-step CI cannot certify a compiler")
    if evidence.get("zero_step_result") != "NOT_EXECUTED":
        raise ValueError("zero-step jobs misclassified")
    backends = data.get("backends")
    if not isinstance(backends, dict) or set(backends) != set(BACKENDS):
        raise ValueError("all five backend claims must be present")
    for backend in BACKENDS:
        if backends[backend] != STATUS:
            raise ValueError("unsupported/false runtime claim: " + backend)
    return len(BARRIERS)

def main(argv):
    path = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parents[1] / "contracts/v1/actor_arena_quiescence_matrix_v2.json"
    total = verify(json.loads(path.read_text(encoding="utf-8")))
    print(f"source-free quiescence matrix accepted: {len(BACKENDS)} backends, {total} barriers; runtime=NOT_VERIFIED")
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(f"FAILED: {error}", file=sys.stderr)
        sys.exit(1)
