#!/usr/bin/env python3
import json, sys
from pathlib import Path

EXPECTED = {"schema":"oreslang.structural_tuple_v2_security.v1","revision":1,"tuple_arity":{"min":2,"max":64},"overload_family_max":128,"optional_slots":"trailing_suffix_only","structural_view":{"readonly":True,"nonescaping":True,"hidden_tail_must_be_closed_readonly_safe":True,"runtime_shape_dispatch":False},"spread":{"explicit_only":True,"evaluate_source_once":True,"direct_arity_precedes_pack":True,"no_fallback_after_direct_selection":True,"pack_requires_unique_static_candidate":True,"same_arity_shape_overloading":False},"disallowed_proof_types":["unknown","generic","borrow","mutable-borrow","function","actor-ref","class-namespace","dynamic-list","fixed-array","fixed-list","void","null"],"abi":{"no_numeric_coercion":True,"no_padding":True,"no_implicit_flatten":True,"omitted_optional_is_absence_not_null":True,"lexical_evaluation_order_preserved":True},"evidence":{"source_free_contract_is_not_runtime_parity":True,"zero_step_jobs":"NOT_EXECUTED","exact_head_required":True,"private_source_export_requires_independent_authorization":True}}

def verify(data):
    if data != EXPECTED:
        raise ValueError("tuple-v2 security contract drift")
    if data["tuple_arity"] != {"min": 2, "max": 64}:
        raise ValueError("tuple arity invariant changed")
    if data["overload_family_max"] != 128:
        raise ValueError("tuple overload family bound changed")
    if data["optional_slots"] != "trailing_suffix_only":
        raise ValueError("optional tuple slot rule changed")
    spread = data["spread"]
    for key in ("explicit_only","evaluate_source_once","direct_arity_precedes_pack",
                "no_fallback_after_direct_selection","pack_requires_unique_static_candidate"):
        if spread.get(key) is not True:
            raise ValueError("spread invariant weakened: " + key)
    if spread.get("same_arity_shape_overloading") is not False:
        raise ValueError("runtime shape overload dispatch enabled")
    view = data["structural_view"]
    if not (view["readonly"] and view["nonescaping"]
            and view["hidden_tail_must_be_closed_readonly_safe"]):
        raise ValueError("structural tuple view weakened")
    if view["runtime_shape_dispatch"] is not False:
        raise ValueError("runtime shape dispatch enabled")
    abi = data["abi"]
    for key in ("no_numeric_coercion","no_padding","no_implicit_flatten",
                "omitted_optional_is_absence_not_null",
                "lexical_evaluation_order_preserved"):
        if abi.get(key) is not True:
            raise ValueError("ABI invariant weakened: " + key)
    evidence = data["evidence"]
    if evidence["zero_step_jobs"] != "NOT_EXECUTED":
        raise ValueError("zero-step CI misclassified")
    return True

def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else (
        Path(__file__).resolve().parents[1] /
        "contracts/structural/v2/tuple-security.v1.json")
    verify(json.loads(path.read_text(encoding="utf-8")))
    print("tuple-v2 security contract accepted")
if __name__ == "__main__":
    main()
