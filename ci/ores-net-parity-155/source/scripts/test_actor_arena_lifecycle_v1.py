#!/usr/bin/env python3
"""Adversarial source-free tests for actor arena lifecycle/quiescence v1."""
import copy
from pathlib import Path
import unittest
from verify_actor_arena_lifecycle_v1 import ContractError, validate, validate_raw

DATA = Path(__file__).resolve().parents[1] / "contracts/v1/actor_arena_lifecycle_v1.json"

class ActorArenaLifecycleV1Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = validate_raw(DATA.read_bytes())

    def reject(self, mutate):
        doc = copy.deepcopy(self.base)
        mutate(doc)
        with self.assertRaises(ContractError):
            validate(doc)

    def test_original(self): validate(self.base)
    def test_duplicate_wire_key(self):
        with self.assertRaises(ContractError): validate_raw(b'{"contract":"x","contract":"y"}')
    def test_bom(self):
        with self.assertRaises(ContractError): validate_raw(b"\xef\xbb\xbf" + DATA.read_bytes())
    def test_missing_backend(self): self.reject(lambda d: d["backend_support"].pop("forge"))
    def test_unknown_backend(self): self.reject(lambda d: d["backend_support"].update({"other": {}}))
    def test_invariant_drop(self): self.reject(lambda d: d["required_invariants"].pop())
    def test_invariant_reorder(self): self.reject(lambda d: d["required_invariants"].reverse())
    def test_actorref_arena_access_must_not_be_removed(self): self.reject(lambda d: d["required_invariants"].remove("actorref-never-grants-arena-access"))
    def test_scratch_turn_exit_must_not_be_removed(self): self.reject(lambda d: d["required_invariants"].remove("scratch-invalid-after-every-turn-exit"))
    def test_logical_retirement_precedes_quiescence(self): self.reject(lambda d: d["required_invariants"].remove("logical-retirement-revokes-new-authority-before-quiescence"))
    def test_external_pin_cannot_grant_memory_access(self): self.reject(lambda d: d["required_invariants"].remove("external-lifetime-pins-grant-no-memory-access"))
    def test_external_owners_must_register_pin(self): self.reject(lambda d: d["required_invariants"].remove("continuation-borrow-ffi-io-owners-must-register-lifetime-pins"))
    def test_reclamation_quiescence_must_not_be_removed(self): self.reject(lambda d: d["required_invariants"].remove("physical-reclaim-waits-for-live-turns-borrows-and-external-pins"))
    def test_late_callback_cannot_resurrect(self): self.reject(lambda d: d["required_invariants"].remove("late-callbacks-cannot-resurrect-retired-authority"))
    def test_external_pin_close_is_idempotent(self): self.reject(lambda d: d["required_invariants"].remove("external-pin-release-is-idempotent"))
    def test_shared_domain_must_quiesce_members_and_leases(self): self.reject(lambda d: d["required_invariants"].remove("shared-domain-reclaim-waits-for-members-and-leases"))
    def test_quota_failure_is_accounting_neutral(self): self.reject(lambda d: d["required_invariants"].remove("quota-charge-precedes-allocation-and-failed-admission-is-accounting-neutral"))
    def test_rejected_construction_does_not_burn_identity(self): self.reject(lambda d: d["required_invariants"].remove("rejected-construction-does-not-consume-capability-identity"))
    def test_nontrivial_values_drop_exactly_once(self): self.reject(lambda d: d["required_invariants"].remove("nontrivial-values-drop-exactly-once-before-bulk-reclaim"))
    def test_identity_and_generation_never_wrap_live(self): self.reject(lambda d: d["required_invariants"].remove("identity-and-generation-counters-never-wrap-into-live-authority"))
    def test_double_release_and_retire_race_cannot_underflow(self): self.reject(lambda d: d["required_invariants"].remove("double-release-and-retire-races-cannot-underflow-accounting"))
    def test_cross_actor_capability_smuggling_cannot_grant_private_arena(self): self.reject(lambda d: d["required_invariants"].remove("cross-actor-capability-transfer-never-grants-private-arena-authority"))
    def test_snapshot_restore_cannot_resurrect_stale_authority(self): self.reject(lambda d: d["required_invariants"].remove("snapshot-restore-cannot-revive-retired-or-stale-authority"))
    def test_failed_reclaim_keeps_retirement_and_dirty_capacity_hidden(self): self.reject(lambda d: d["required_invariants"].remove("reclaim-failure-keeps-logical-retirement-and-dirty-capacity-unpublished"))
    def test_java_general_lowering_cannot_be_promoted(self): self.reject(lambda d: d["backend_support"]["java"].update({"general_guest_value_lowering":"implemented"}))
    def test_llvm_general_lowering_cannot_be_promoted(self): self.reject(lambda d: d["backend_support"]["llvm"].update({"general_guest_value_lowering":"implemented"}))
    def test_java_pin_model_is_native_loan_prototype(self): self.reject(lambda d: d["backend_support"]["java"].update({"lifetime_pin_model":"external-lifetime-lease-prototype"}))
    def test_llvm_pin_model_is_native_loan_accounting(self): self.reject(lambda d: d["backend_support"]["llvm"].update({"lifetime_pin_model":"external-lifetime-lease-prototype"}))
    def test_net_pin_model_is_external_lease(self): self.reject(lambda d: d["backend_support"]["net"].update({"lifetime_pin_model":"none"}))
    def test_wasm_pin_model_is_external_lease(self): self.reject(lambda d: d["backend_support"]["wasm"].update({"lifetime_pin_model":"none"}))
    def test_forge_pin_model_is_external_lease(self): self.reject(lambda d: d["backend_support"]["forge"].update({"lifetime_pin_model":"none"}))
    def test_llvm_shared_domain_is_only_host_prototype(self): self.reject(lambda d: d["backend_support"]["llvm"].update({"shared_domain_arena":"implemented"}))
    def test_other_shared_domains_cannot_be_promoted(self):
        for backend in ("java", "net", "wasm", "forge"):
            with self.subTest(backend=backend): self.reject(lambda d, b=backend: d["backend_support"][b].update({"shared_domain_arena":"implemented"}))
    def test_callback_wiring_stays_unverified(self):
        for backend in self.base["backend_support"]:
            with self.subTest(backend=backend): self.reject(lambda d, b=backend: d["backend_support"][b].update({"continuation_ffi_io_wiring":"implemented"}))
    def test_zero_host_gc_not_certified(self):
        for backend in self.base["backend_support"]:
            with self.subTest(backend=backend): self.reject(lambda d, b=backend: d["backend_support"][b].update({"zero_host_gc_certified": True}))
    def test_native_aot_not_certified(self):
        for backend in self.base["backend_support"]:
            with self.subTest(backend=backend): self.reject(lambda d, b=backend: d["backend_support"][b].update({"native_aot_certified": True}))
    def test_exact_head_ci_not_certified(self):
        for backend in self.base["backend_support"]:
            with self.subTest(backend=backend): self.reject(lambda d, b=backend: d["backend_support"][b].update({"exact_head_ci_certified": True}))
    def test_candidate_stage_must_match_backend(self): self.reject(lambda d: d["backend_support"]["llvm"].update({"candidate_stage":"candidate-host-only-native-arena"}))
    def test_backend_row_cannot_omit_pin_model(self): self.reject(lambda d: d["backend_support"]["net"].pop("lifetime_pin_model"))
    def test_backend_row_cannot_add_unknown_field(self): self.reject(lambda d: d["backend_support"]["forge"].update({"callback_magic": True}))

if __name__ == "__main__":
    unittest.main()
