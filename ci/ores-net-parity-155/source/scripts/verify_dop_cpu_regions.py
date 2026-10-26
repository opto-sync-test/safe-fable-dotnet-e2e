#!/usr/bin/env python3
"""Validate a shared DOP CPU region contract and strictly typed backend report.

This does NOT execute a compiler or authenticate CI links. Only actual backend
runners may provide evidence; a well-formed report is not runtime parity.
"""
import argparse
import json
import re
from pathlib import Path

CONTRACT = Path(__file__).resolve().parents[1] / "contracts/v1/dop-cpu-regions/cases.json"
BACKENDS = {"java", "llvm", "net", "wasm", "forge"}
ID = re.compile(r"^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*$")
SHA = re.compile(r"^[0-9a-f]{40}$")
RUN = re.compile(r"^https://github\.com/[^/]+/[^/]+/actions/runs/[0-9]+$")

def require(predicate, reason):
    if not predicate:
        raise ValueError(reason)


# Freeze the normative case inventory independently of the on-disk JSON.
CANONICAL_SCOPE = "Backend-neutral expected behavior for owned scalar f32 host regions; not evidence of implementation or GPU support"
CANONICAL_REQUIREMENTS = (
    "Explicit per-allocation identity; ownership transfer preserves identity",
    "Borrowed buffers cannot be closed or moved",
    "Region slices are half-open row intervals",
    "Admission failures cannot partially modify destination",
    "No GPU dispatch or fallback may be inferred from this CPU contract",
)
CANONICAL_CASES = (
    ("geometry/aos-offset", "layout", "valid"),
    ("geometry/soa-offset", "layout", "valid"),
    ("geometry/aosoa-tail-tile", "layout", "valid"),
    ("geometry/checked-overflow", "layout", "reject"),
    ("geometry/zero-rows", "layout", "valid"),
    ("ownership/stable-id-through-take", "ownership", "valid"),
    ("ownership/stale-owner-reject", "ownership", "reject"),
    ("ownership/close-idempotent", "ownership", "valid"),
    ("ownership/close-with-reader", "ownership", "reject"),
    ("ownership/close-with-writer", "ownership", "reject"),
    ("ownership/retired-region", "ownership", "reject"),
    ("loans/exclusive-writer-vs-reader", "loans", "reject"),
    ("loans/readers-coexist", "loans", "valid"),
    ("execute/half-open-write-footprint", "execute", "valid"),
    ("execute/three-scalar-ops", "execute", "valid"),
    ("execute/alias-input-output", "execute", "reject"),
    ("execute/invalid-effect", "execute", "reject"),
    ("execute/mismatched-layout", "execute", "reject"),
    ("execute/no-partial-write-on-admission-failure", "execute", "valid"),
    ("scheduler/overlap-serialization", "scheduler", "valid"),
    ("scheduler/disjoint-read-independence", "scheduler", "valid"),
    ("gpu/no-implicit-cpu-fallback", "gpu-boundary", "reject"),
)

def load_json_strict(path):
    def pairs_to_unique_object(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "duplicate JSON object key: " + key)
            value[key] = item
        return value

    def nonstandard_number(value):
        raise ValueError("nonstandard JSON constant: " + value)

    return json.loads(path.read_text(encoding="utf-8"),
                      object_pairs_hook=pairs_to_unique_object,
                      parse_constant=nonstandard_number)

def check_contract(contract):
    require(type(contract) is dict, "contract must be an object")
    require(set(contract) == {"contract", "version", "scope", "shape",
                              "effects", "requirements", "cases"},
            "unexpected normative contract fields")
    require(contract.get("contract") == "oreslang.dop.cpu-regions"
            and type(contract.get("version")) is int
            and contract["version"] == 1, "unexpected DOP contract version")
    require(contract["scope"] == CANONICAL_SCOPE, "unexpected scope disclaimer")
    require(contract["requirements"] == list(CANONICAL_REQUIREMENTS),
            "changed normative requirements")
    shape = contract.get("shape")
    require(type(shape) is dict
            and set(shape) == {"scalar_bytes", "alignment", "fields", "rows",
                               "aosoa_lanes", "layouts"}
            and all(type(shape[key]) is int for key in (
                "scalar_bytes", "alignment", "fields", "rows", "aosoa_lanes"))
            and shape["scalar_bytes"] == 4
            and shape["alignment"] == 16 and shape["fields"] == 3
            and shape["rows"] == 7 and shape["aosoa_lanes"] == 4
            and shape["layouts"] == ["AoS", "SoA", "AoSoA"],
            "unrecognized ABI shape")
    require(contract.get("effects") == ["READ", "WRITE", "DISCARD", "REDUCE", "ATOMIC"],
            "unrecognized effect vocabulary")
    cases = contract.get("cases")
    require(type(cases) is list and len(cases) == len(CANONICAL_CASES),
            "normative DOP case inventory changed")
    ids = []
    for case in cases:
        require(type(case) is dict and set(case) == {"id", "domain", "expected"},
                "case must use only normative fields")
        require(type(case["id"]) is str and ID.fullmatch(case["id"]),
                "invalid case identifier")
        require(type(case["expected"]) is str
                and case["expected"] in {"valid", "reject"}, "invalid case expectation")
        require(type(case["domain"]) is str
                and case["domain"] in {"layout", "ownership", "loans", "execute",
                                       "scheduler", "gpu-boundary"}, "invalid case domain")
        require((case["id"], case["domain"], case["expected"])
                == CANONICAL_CASES[len(ids)],
                "modified or reordered normative case: " + case["id"])
        ids.append(case["id"])
    require(len(set(ids)) == len(ids), "duplicate DOP case ID")
    return ids

def check_report(report, case_ids):
    require(type(report) is dict
            and set(report) == {"contract", "version", "backend", "implementation", "cases"},
            "report requires exact top-level fields")
    require(report["contract"] == "oreslang.dop.cpu-regions"
            and type(report["version"]) is int and report["version"] == 1,
            "report targets wrong contract")
    require(type(report["backend"]) is str and report["backend"] in BACKENDS, "unknown backend")
    require(type(report["implementation"]) is str
            and report["implementation"] in {"unsupported", "partial", "implemented"},
            "invalid implementation claim")
    records = report["cases"]
    require(type(records) is list and len(records) == len(case_ids),
            "report must enumerate every contract case exactly once")
    seen = set()
    passed = 0
    for item in records:
        require(type(item) is dict and set(item) == {
            "id", "status", "executed", "passed", "evidence"
        }, "missing or contradictory case metadata")
        name = item["id"]
        require(type(name) is str and name in case_ids and name not in seen,
                "unknown or duplicate case")
        seen.add(name)
        require(type(item["status"]) is str
                and item["status"] in {"pass", "unsupported"}, "ambiguous report status")
        require(type(item["executed"]) is bool and type(item["passed"]) is bool,
                "executed and passed must be booleans")
        evidence = item["evidence"]
        require(type(evidence) is list, "case evidence must be a list")
        if item["status"] == "pass":
            require(item["executed"] and item["passed"] and len(evidence) >= 1,
                    "passing case must actually execute and carry evidence")
            for proof in evidence:
                require(type(proof) is dict and set(proof) == {
                    "source_commit", "run_url", "backend"
                }, "invalid evidence object")
                require(proof["backend"] == report["backend"],
                        "cross-backend evidence is not executable parity")
                require(type(proof["source_commit"]) is str
                        and SHA.fullmatch(proof["source_commit"]), "missing exact source SHA")
                require(type(proof["run_url"]) is str and RUN.fullmatch(proof["run_url"]),
                        "missing canonical GitHub Actions run link")
            passed += 1
        else:
            require(item["executed"] is False and item["passed"] is False
                    and evidence == [], "unsupported case cannot claim execution")
    require(set(case_ids) == seen, "some cases omitted from report")
    claim = report["implementation"]
    require((claim == "unsupported" and passed == 0)
            or (claim == "partial" and 0 < passed < len(case_ids))
            or (claim == "implemented" and passed == len(case_ids)),
            "backend implementation status contradicts observed case statuses")
    return passed

def self_test(contract):
    names = check_contract(contract)
    # Fixtures intentionally use synthetic evidence, never a real parity claim.
    pending = [{"id": name, "status": "unsupported", "executed": False,
                "passed": False, "evidence": []} for name in names]
    example = {"contract": "oreslang.dop.cpu-regions", "version": 1,
               "backend": "java", "implementation": "unsupported", "cases": pending}
    require(check_report(example, names) == 0, "baseline negative evidence rejected")
    import copy
    def must_reject(mutator):
        copy_report = copy.deepcopy(example)
        mutator(copy_report)
        try:
            check_report(copy_report, names)
        except ValueError:
            return
        raise AssertionError("report validator admitted a contradictory parity claim")
    must_reject(lambda r: r["cases"][0].update(status="pass"))
    must_reject(lambda r: r["cases"][0].update(skipped=True))
    must_reject(lambda r: r["cases"][0].update(executed=True))
    must_reject(lambda r: r["cases"][0].update(id=names[1]))
    must_reject(lambda r: r.update(implementation="implemented"))
    def reject_contract(mutator):
        candidate = copy.deepcopy(contract)
        mutator(candidate)
        try:
            check_contract(candidate)
        except ValueError:
            return
        raise AssertionError("validator admitted mutation of normative contract")

    reject_contract(lambda c: c["cases"][0].update(id="geometry/fake-offset"))
    reject_contract(lambda c: c["cases"][0].update(domain="ownership"))
    reject_contract(lambda c: c["cases"][0].update(expected="reject"))
    reject_contract(lambda c: c["cases"].reverse())
    reject_contract(lambda c: c["requirements"].clear())
    reject_contract(lambda c: c.update(scope="runtime implemented"))
    reject_contract(lambda c: c.update(version=True))
    reject_contract(lambda c: c.update(extra="unreviewed"))
    reject_contract(lambda c: c["shape"].update(device_supported=True))
    reject_contract(lambda c: c["shape"].update(scalar_bytes=True))
    must_reject(lambda r: r.update(version=True))
    must_reject(lambda r: r["cases"][0].update(status=[]))
    must_reject(lambda r: r.update(backend=[]))

    # Prove that the verifier accepts coherent report shapes, not only rejects
    # bad ones. Evidence here is deliberately synthetic, not CI attestation.
    def mark_pass(record):
        record.update(status="pass", executed=True, passed=True, evidence=[{
            "source_commit": "0" * 40,
            "run_url": "https://github.com/example/private-ci/actions/runs/1",
            "backend": "java",
        }])

    partial = copy.deepcopy(example)
    partial["implementation"] = "partial"
    mark_pass(partial["cases"][0])
    require(check_report(partial, names) == 1, "valid partial report rejected")
    complete = copy.deepcopy(example)
    complete["implementation"] = "implemented"
    for item in complete["cases"]:
        mark_pass(item)
    require(check_report(complete, names) == len(names),
            "valid full synthetic report rejected")

    class FakeDocument:
        def __init__(self, content):
            self.content = content
        def read_text(self, encoding="utf-8"):
            return self.content

    require(load_json_strict(FakeDocument('{"ok":true}')) == {"ok": True},
            "valid JSON rejected")
    for invalid in ('{"case":1,"case":2}', '{"quantity":NaN}'):
        try:
            load_json_strict(FakeDocument(invalid))
        except ValueError:
            continue
        raise AssertionError("decoder accepted duplicate keys or nonstandard numbers")
    print("DOP CPU v1: 22 canonical cases, 20 fail-closed mutants; valid report shapes PASS")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, help="backend execution report JSON")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    contract = load_json_strict(CONTRACT)
    names = check_contract(contract)
    if args.self_test:
        self_test(contract)
    if args.report:
        report = load_json_strict(args.report)
        count = check_report(report, names)
        print(f"DOP CPU v1: validated report structure, {count}/{len(names)} recorded passes")
        print("Note: report validation does not independently authenticate execution evidence")
    elif not args.self_test:
        print(f"DOP CPU v1: {len(names)} well-formed contract cases (NOT runtime parity)")

if __name__ == "__main__":
    main()
