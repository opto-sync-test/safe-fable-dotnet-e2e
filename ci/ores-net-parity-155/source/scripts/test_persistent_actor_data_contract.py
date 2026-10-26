#!/usr/bin/env python3
"""Negative policy mutations; no claim of guest/runtime execution."""
import copy
import json
import unittest
from pathlib import Path
from verify_persistent_actor_data_contract import ContractError, validate, validate_raw

DATA = Path(__file__).resolve().parents[1] / "contracts/v1/persistent_actor_data_v1.json"


class PersistentActorPolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = validate_raw(DATA.read_bytes())

    def reject(self, transform):
        value = copy.deepcopy(self.base)
        transform(value)
        with self.assertRaises(ContractError):
            validate(value)

    def test_original(self):
        validate(self.base)

    def test_duplicate_wire_key(self):
        with self.assertRaises(ContractError):
            validate_raw(b'{"x":1,"x":2}')

    def test_bom(self):
        with self.assertRaises(ContractError):
            validate_raw(b"\xef\xbb\xbf" + DATA.read_bytes())

    def test_unknown_backend(self):
        self.reject(lambda d: d["backend_support"].update({"other": {}}))

    def test_claim_premature_native_hamt(self):
        self.reject(lambda d: d["backend_support"]["llvm"].update({"native_backed_hamt": "implemented"}))

    def test_claim_premature_source_syntax(self):
        self.reject(lambda d: d["backend_support"]["java"].update({"source_language_persistent_map": "implemented"}))

    def test_forge_false_implementation(self):
        self.reject(lambda d: d["backend_support"]["forge"].update({"hamt_runtime": "host-prototype"}))

    def test_collision_cap_expansion(self):
        self.reject(lambda d: d["limits"].update({"collision_bucket_max": 100000}))

    def test_depth_budget_expansion(self):
        self.reject(lambda d: d["limits"].update({"actor_message_graph_depth_max": 999999}))

    def test_graph_budget_expansion(self):
        self.reject(lambda d: d["limits"].update({"actor_message_graph_nodes_max": 999999}))

    def test_drop_fixture(self):
        self.reject(lambda d: d["cases"].pop())

    def test_duplicate_fixture(self):
        self.reject(lambda d: d["cases"].append(d["cases"][0]))

    def test_weaken_quota(self):
        self.reject(lambda d: d["cases"].__setitem__(17, {
            "id": "hamt-duplicate-send-quota", "domain": "actor-quotas", "expect": "unsupported"}))

    def test_weaken_immutability(self):
        self.reject(lambda d: next(c for c in d["cases"] if c["id"] == "hamt-array-input")
                    .update({"expect": "preserve-identity"}))

    def test_allow_new_mutable_type(self):
        self.reject(lambda d: d["value_domain"].append("mutable-buffer"))

    def test_claim_runtime_parity(self):
        self.reject(lambda d: d.update({"scope": "five backend runtime parity verified"}))

    def test_reject_float_collision_limit(self):
        self.reject(lambda d: d["limits"].update({"collision_bucket_max": 64.0}))

    def test_reject_float_graph_budget(self):
        self.reject(lambda d: d["limits"].update({"actor_message_graph_nodes_max": 100000.0}))

    def test_reject_unhashable_domain_without_crash(self):
        self.reject(lambda d: d["cases"][0].update({"domain": ["persistent-map"]}))

    def test_reject_unhashable_outcome_without_crash(self):
        self.reject(lambda d: d["cases"][0].update({"expect": ["old-root-preserved"]}))

    def test_reject_ambiguous_scope_claim(self):
        self.reject(lambda d: d.update({"scope": d["scope"] + "; claimed parity verified"}))

    def test_reject_nonfinite_wire_token(self):
        with self.assertRaises(ContractError):
            validate_raw(b'{"version": NaN}')

    def test_oversized_json_integer_must_fail_closed(self):
        # CPython 3.11+ can raise ValueError before schema validation.
        with self.assertRaises(ContractError):
            validate_raw(b'{"version":' + b'9' * 5000 + b'}')

    def test_extreme_json_depth_must_fail_closed(self):
        nested = b'[' * 5000 + b'0' + b']' * 5000
        with self.assertRaises(ContractError):
            validate_raw(nested)




if __name__ == "__main__":
    unittest.main()
