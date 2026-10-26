#!/usr/bin/env python3
"""Fail-closed, offline verification of the shared persistent-actor-data contract.

A passing contract check proves the fixture and capability declarations agree,
NOT that the backend has implemented persistent maps or passed runtime tests.
"""
import json
from pathlib import Path
import sys

EXPECTED_IDS = frozenset(["hamt-path-copy","hamt-delete","hamt-aa-bb","hamt-high-hash-bits","hamt-collision-over-64","hamt-nested-root","hamt-array-input","hamt-mutable-map-input","hamt-foreign-reference","hamt-numeric-subclass","hamt-null-value","hamt-clear-empty","hamt-remove-missing","hamt-remove-if-predicate","hamt-shared-mailbox","hamt-private-mailbox","hamt-untrusted-mailbox","hamt-duplicate-send-quota","hamt-drain-credit-release","hamt-depth-257","hamt-node-budget","pure-actor-single-reducer","pure-actor-no-suspend","pure-actor-no-ambient-io","pure-actor-command-effects","persistent-source-syntax","persistent-vector","edn-wire-shortcut","typed-map-mutating-adapter"])
BACKENDS = ("java", "llvm", "net", "wasm", "forge")
ALLOWED_RESULTS = {"old-root-preserved", "two-distinct-keys", "consistent-lookup",
                   "reject", "preserve-identity", "reject-without-callback",
                   "isolated-copy", "charge-each-envelope", "release-each-envelope",
                   "require-one-exhaustive", "bounded-command-effects", "unsupported"}
DOMAINS = {"persistent-map", "hash-collision", "immutability", "actor-transport",
           "actor-quotas", "pure-actor", "source-language", "interoperability"}


class ContractError(ValueError):
    pass


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ContractError("duplicate JSON key: " + key)
        result[key] = value
    return result


def _bad_constant(value):
    raise ContractError("non-finite JSON number: " + value)


def validate_raw(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > 64 * 1024:
        raise ContractError("invalid or oversized persistent contract")
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ContractError("BOM forbidden")
    try:
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_pairs,
                          parse_constant=_bad_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ContractError("invalid canonical UTF-8 JSON") from exc
    validate(data)
    return data


def _require(condition, message):
    if not condition:
        raise ContractError(message)


def validate(doc):
    _require(type(doc) is dict, "top-level contract must be an object")
    _require(set(doc) == {"contract", "version", "scope", "limits", "value_domain",
                          "backend_support", "cases"}, "unknown or missing contract fields")
    _require(doc["contract"] == "oreslang-persistent-actor-data-v1"
             and type(doc["version"]) is int and doc["version"] == 1,
             "contract identity/version mismatch")
    _require(doc["scope"] == "shared safety test vectors and conservative capability claims; not executable runtime parity",
             "the contract must not claim runtime parity")
    _require(type(doc["limits"]) is dict and all(type(v) is int for v in doc["limits"].values()),
             "quota bounds must be canonical integers")
    _require(doc["limits"] == {
        "collision_bucket_max": 64,
        "actor_message_graph_depth_max": 256,
        "actor_message_graph_nodes_max": 100000}, "quota or collision bounds drift")
    _require(type(doc["value_domain"]) is list
             and doc["value_domain"] == ["string","boolean","character","byte","short","integer","long","float","double","bigint-exact","bigdecimal-exact","nested-persistent-map"],
             "allowed value domain changed without version bump")
    support = doc["backend_support"]
    _require(type(support) is dict and set(support) == set(BACKENDS),
             "all five backends require explicit status")
    for backend, claims in support.items():
        _require(type(claims) is dict and set(claims) == {
            "hamt_runtime", "shared_identity", "pure_reducer_contract",
            "source_language_persistent_map", "native_backed_hamt"},
            "incomplete backend capability declaration")
        for feature, stage in claims.items():
            allowed = "host-prototype" if backend == "java" and feature in (
                "hamt_runtime", "shared_identity", "pure_reducer_contract") else "unsupported"
            _require(stage == allowed,
                     "unverified backend capability promotion: " + backend + "/" + feature)
    cases = doc["cases"]
    _require(type(cases) is list and len(cases) == len(EXPECTED_IDS),
             "case count does not match v1")
    ids = set()
    for item in cases:
        _require(type(item) is dict and set(item) == {"id", "domain", "expect"},
                 "case fields changed without contract bump")
        _require(type(item["id"]) is str and item["id"] in EXPECTED_IDS
                 and item["id"] not in ids, "unknown or duplicated case")
        _require(type(item["domain"]) is str and type(item["expect"]) is str
                 and item["domain"] in DOMAINS and item["expect"] in ALLOWED_RESULTS,
                 "unknown domain or outcome")
        ids.add(item["id"])
    _require(ids == EXPECTED_IDS, "missing case")
    expected = dict([["hamt-path-copy",["persistent-map","old-root-preserved"]],["hamt-delete",["persistent-map","old-root-preserved"]],["hamt-aa-bb",["hash-collision","two-distinct-keys"]],["hamt-high-hash-bits",["hash-collision","consistent-lookup"]],["hamt-collision-over-64",["hash-collision","reject"]],["hamt-nested-root",["immutability","preserve-identity"]],["hamt-array-input",["immutability","reject"]],["hamt-mutable-map-input",["immutability","reject"]],["hamt-foreign-reference",["immutability","reject"]],["hamt-numeric-subclass",["immutability","reject"]],["hamt-null-value",["immutability","reject"]],["hamt-clear-empty",["immutability","reject-without-callback"]],["hamt-remove-missing",["immutability","reject-without-callback"]],["hamt-remove-if-predicate",["immutability","reject-without-callback"]],["hamt-shared-mailbox",["actor-transport","preserve-identity"]],["hamt-private-mailbox",["actor-transport","isolated-copy"]],["hamt-untrusted-mailbox",["actor-transport","isolated-copy"]],["hamt-duplicate-send-quota",["actor-quotas","charge-each-envelope"]],["hamt-drain-credit-release",["actor-quotas","release-each-envelope"]],["hamt-depth-257",["actor-quotas","reject"]],["hamt-node-budget",["actor-quotas","reject"]],["pure-actor-single-reducer",["pure-actor","require-one-exhaustive"]],["pure-actor-no-suspend",["pure-actor","reject"]],["pure-actor-no-ambient-io",["pure-actor","reject"]],["pure-actor-command-effects",["pure-actor","bounded-command-effects"]],["persistent-source-syntax",["source-language","unsupported"]],["persistent-vector",["source-language","unsupported"]],["edn-wire-shortcut",["interoperability","unsupported"]],["typed-map-mutating-adapter",["interoperability","unsupported"]]])
    for item in cases:
        _require([item["domain"], item["expect"]] == expected[item["id"]],
                 "unsafe fixture outcome changed: " + item["id"])


if __name__ == "__main__":
    path = Path(sys.argv[1]) if len(sys.argv) == 2 else (
        Path(__file__).resolve().parents[1] / "contracts/v1/persistent_actor_data_v1.json")
    try:
        d = validate_raw(path.read_bytes())
    except (OSError, ContractError) as exc:
        print("PERSISTENT_ACTOR_CONTRACT_DENIED: " + str(exc), file=sys.stderr)
        sys.exit(1)
    print("PERSISTENT_ACTOR_CONTRACT_PASS: cases=%d backends=%d (policy only)" %
          (len(d["cases"]), len(d["backend_support"])))
