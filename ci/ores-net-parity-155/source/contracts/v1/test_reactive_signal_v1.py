import copy
import json
import unittest
from pathlib import Path
from verify_reactive_signal_v1 import validate
GOOD=json.loads((Path(__file__).parent / "reactive-signal-v1.json").read_text())
class AdmissionTests(unittest.TestCase):
    def test_unsupported_profile(self):
        validate(copy.deepcopy(GOOD))
    def test_forged_evidence_cannot_promote_any_feature(self):
        for name in GOOD["features"]:
            for evidence in (True, "passed", {"status":"success"}):
                with self.subTest(name=name,evidence=evidence):
                    doc=copy.deepcopy(GOOD)
                    doc["features"][name]="implemented"
                    doc["executed_evidence"][name]=evidence
                    with self.assertRaises(SystemExit): validate(doc)
    def test_all_features_promoted_still_rejected(self):
        doc=copy.deepcopy(GOOD)
        doc["features"]={k:"implemented" for k in doc["features"]}
        doc["executed_evidence"]={k:True for k in doc["features"]}
        with self.assertRaises(SystemExit): validate(doc)
    def test_each_semantic_flag_is_exact_true(self):
        for key in GOOD["semantics"]:
            for value in (False,1,"true",None):
                with self.subTest(key=key,value=value):
                    doc=copy.deepcopy(GOOD);doc["semantics"][key]=value
                    with self.assertRaises(SystemExit): validate(doc)
    def test_backend_and_semantics_inventory(self):
        doc=copy.deepcopy(GOOD);doc["backend"]="foreign"
        with self.assertRaises(SystemExit): validate(doc)
        doc=copy.deepcopy(GOOD);doc["semantics"]["extra"]=True
        with self.assertRaises(SystemExit): validate(doc)
    def test_evidence_on_unsupported_profile_rejected(self):
        doc=copy.deepcopy(GOOD);doc["executed_evidence"]={"claim":"passed"}
        with self.assertRaises(SystemExit): validate(doc)
if __name__=="__main__": unittest.main()
