#!/usr/bin/env python3
import copy, json
from pathlib import Path
from verify_tuple_v2_security import verify

ROOT = Path(__file__).resolve().parents[1]
base = json.loads((ROOT / "contracts/structural/v2/tuple-security.v1.json").read_text())
assert verify(base)
mutations = [
 lambda d: d["tuple_arity"].update(min=1),
 lambda d: d["tuple_arity"].update(max=65),
 lambda d: d.update(overload_family_max=1000000),
 lambda d: d.update(optional_slots="anywhere"),
 lambda d: d["structural_view"].update(readonly=False),
 lambda d: d["structural_view"].update(nonescaping=False),
 lambda d: d["structural_view"].update(hidden_tail_must_be_closed_readonly_safe=False),
 lambda d: d["structural_view"].update(runtime_shape_dispatch=True),
 lambda d: d["spread"].update(explicit_only=False),
 lambda d: d["spread"].update(evaluate_source_once=False),
 lambda d: d["spread"].update(direct_arity_precedes_pack=False),
 lambda d: d["spread"].update(no_fallback_after_direct_selection=False),
 lambda d: d["spread"].update(pack_requires_unique_static_candidate=False),
 lambda d: d["spread"].update(same_arity_shape_overloading=True),
 lambda d: d["abi"].update(no_numeric_coercion=False),
 lambda d: d["abi"].update(no_padding=False),
 lambda d: d["abi"].update(no_implicit_flatten=False),
 lambda d: d["abi"].update(omitted_optional_is_absence_not_null=False),
 lambda d: d["abi"].update(lexical_evaluation_order_preserved=False),
 lambda d: d["evidence"].update(zero_step_jobs="PASS"),
]
rejected=0
for mutate in mutations:
    candidate=copy.deepcopy(base)
    mutate(candidate)
    try: verify(candidate)
    except ValueError: rejected += 1
if rejected != len(mutations):
    raise AssertionError(f"only {rejected}/{len(mutations)} weakened contracts rejected")
print(f"tuple-v2 negative mutations rejected: {rejected}/{len(mutations)}")
