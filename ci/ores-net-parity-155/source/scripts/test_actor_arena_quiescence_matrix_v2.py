#!/usr/bin/env python3
"""Negative controls for source-free actor-quiescence evidence policy."""
import copy
import json
from pathlib import Path
from verify_actor_arena_quiescence_matrix_v2 import verify

root = Path(__file__).resolve().parents[1]
original = json.loads((root / "contracts/v1/actor_arena_quiescence_matrix_v2.json").read_text())
assert verify(original) == 16

def rejected(mutator):
    candidate = copy.deepcopy(original)
    mutator(candidate)
    try:
        verify(candidate)
    except ValueError:
        return
    raise AssertionError("weakened quiescence contract was accepted")

for index in range(16):
    rejected(lambda data, index=index: data["required_barriers"].pop(index))
rejected(lambda d: d["required_barriers"].append(d["required_barriers"][0]))
rejected(lambda d: d.update(source_free_policy_only=False))
rejected(lambda d: d.update(never_export_private_source_to_unapproved_org=False))
rejected(lambda d: d["mandatory_native_evidence"].update(minimum_executed_job_steps=0))
rejected(lambda d: d["mandatory_native_evidence"].update(zero_step_result="PASS"))
rejected(lambda d: d["mandatory_native_evidence"].update(issuer_bound_required_check=False))
rejected(lambda d: d["mandatory_native_evidence"].update(authorized_source_local_runner=False))
rejected(lambda d: d["backends"].pop("forge"))
rejected(lambda d: d["backends"]["llvm"].update(native_execution="VERIFIED"))
rejected(lambda d: d["backends"]["wasm"].update(source_local_run="PASSED"))
rejected(lambda d: d["backends"]["java"].update(native_aot="VERIFIED"))
print("source-free quiescence mutation tests passed:", 16+11, "negative controls")
