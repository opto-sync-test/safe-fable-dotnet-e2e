#!/usr/bin/env python3
import copy
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_shared_domain_arena_v1 as verify

CANONICAL = verify.load()

class SharedDomainArenaV1Test(unittest.TestCase):
    def test_canonical_validates(self):
        self.assertTrue(verify.validate(copy.deepcopy(CANONICAL)))

    def test_root_fields_are_exact(self):
        self.assertEqual(set(CANONICAL), {
            "contract", "version", "status", "scope", "lifecycle_order",
            "source_semantics", "backend_support", "cases"
        })

    def test_case_inventory_is_37(self):
        self.assertEqual(len(CANONICAL["cases"]), 37)

    def test_case_ids_are_unique(self):
        ids = [case["id"] for case in CANONICAL["cases"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_backend_inventory_is_exact(self):
        self.assertEqual(tuple(CANONICAL["backend_support"]), verify.EXPECTED_BACKENDS)

    def test_all_guest_lowering_is_unsupported(self):
        self.assertTrue(all(
            row["guest_critical_lowering"] == "unsupported"
            for row in CANONICAL["backend_support"].values()
        ))

    def test_all_rt_share_is_unsupported(self):
        self.assertTrue(all(
            row["rt_share"] == "unsupported"
            for row in CANONICAL["backend_support"].values()
        ))

    def test_only_llvm_has_host_prototype(self):
        self.assertEqual(CANONICAL["backend_support"]["llvm"]["host_shared_domain"],
                         "candidate-host-prototype")
        self.assertTrue(all(
            CANONICAL["backend_support"][b]["host_shared_domain"] == "unsupported"
            for b in ("java", "net", "wasm", "forge")
        ))

    def test_no_runtime_evidence_is_certified(self):
        self.assertTrue(all(
            row["exact_head_runtime_evidence"] == "pending"
            for row in CANONICAL["backend_support"].values()
        ))

    def test_unknown_root_field_rejected(self):
        mutated = copy.deepcopy(CANONICAL)
        mutated["certified"] = True
        with self.assertRaises(ValueError):
            verify.validate(mutated)

    def test_missing_case_rejected(self):
        mutated = copy.deepcopy(CANONICAL)
        mutated["cases"].pop()
        with self.assertRaises(ValueError):
            verify.validate(mutated)

    def test_rt_share_promotion_rejected(self):
        mutated = copy.deepcopy(CANONICAL)
        mutated["backend_support"]["llvm"]["rt_share"] = "implemented"
        with self.assertRaises(ValueError):
            verify.validate(mutated)

def _make_case_mutation(case_id, expected):
    def test_case(self):
        mutated = copy.deepcopy(CANONICAL)
        for case in mutated["cases"]:
            if case["id"] == case_id:
                case["expect"] = "unexpected-promotion"
                break
        else:
            self.fail(f"missing canonical case {case_id}")
        with self.assertRaises(ValueError):
            verify.validate(mutated)
        canonical = {c["id"]: c["expect"] for c in CANONICAL["cases"]}
        self.assertEqual(canonical[case_id], expected)
    return test_case

for _case_id, _expected in verify.EXPECTED_CASES.items():
    setattr(
        SharedDomainArenaV1Test,
        "test_case_" + _case_id.replace("-", "_"),
        _make_case_mutation(_case_id, _expected),
    )

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SharedDomainArenaV1Test)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.testsRun != 49:
        raise SystemExit(f"expected 49 tests, ran {result.testsRun}")
    if (not result.wasSuccessful() or result.skipped or result.expectedFailures
            or result.unexpectedSuccesses):
        raise SystemExit(1)
    print("SHARED_DOMAIN_TESTS=49")
