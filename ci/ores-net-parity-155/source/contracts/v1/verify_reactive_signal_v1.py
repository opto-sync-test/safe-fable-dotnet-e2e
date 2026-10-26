#!/usr/bin/env python3
"""Validate an unsupported reactive profile; never certify implementation."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
BACKEND='dotnet'
def validate(doc):
    if doc.get("contract") != "oreslang.reactive-signal.v1":
        raise SystemExit("wrong reactive contract id")
    if doc.get("consumer_signal") != "Result<Option<T>, Option<E>>":
        raise SystemExit("consumer signal ABI drift")
    if doc.get("producer_frame") != "Result<Option<T>, E>":
        raise SystemExit("producer frame ABI drift")
    want = {
        "NEXT": "Ok(Some(T))",
        "COMPLETE": "Ok(None)",
        "CANCELLED": "Err(None)",
        "ERROR": "Err(Some(E))",
    }
    if doc.get("consumer_variants") != want:
        raise SystemExit("four-way consumer variant mapping drift")
    allowed = {"implemented", "syntax_only", "unsupported"}
    features = doc.get("features", {})
    required = {
        "canonical_consumer_signal", "producer_frame", "channel_source",
        "future_source", "mixed_channel_future_select", "observable",
        "credit_pipe",
    }
    if set(features) != required:
        raise SystemExit("reactive feature inventory drift")
    if any(value not in allowed for value in features.values()):
        raise SystemExit("invalid feature status")
    if doc.get("unsupported_policy") != "reject_before_lowering":
        raise SystemExit("unsupported reactive source must fail closed before lowering")
    evidence = doc.get("executed_evidence", {})
    for name, status in features.items():
        if status == "implemented" and not evidence.get(name):
            raise SystemExit(f"implemented feature lacks executable evidence: {name}")
    if features["mixed_channel_future_select"] == "implemented":
        if features["channel_source"] != "implemented" or features["future_source"] != "implemented":
            raise SystemExit("mixed select cannot outrun Channel/Future implementation")
    if features["credit_pipe"] == "implemented":
        deps = ("canonical_consumer_signal", "producer_frame", "channel_source",
                "mixed_channel_future_select")
        if any(features[d] != "implemented" for d in deps):
            raise SystemExit("CreditPipe implementation missing prerequisite")
    if doc.get("backend") != BACKEND:
        raise SystemExit("backend identity drift")
    semantics={"cancellation_is_consumer_control", "nested_option_is_data", "nested_result_err_is_data", "borrowed_producer_not_cancelled_by_adapter", "pending_writes_must_be_bounded"}
    if not isinstance(doc.get("semantics"),dict) or set(doc["semantics"]) != semantics or any(v is not True for v in doc["semantics"].values()):
        raise SystemExit("reactive semantics drift")
    # This metadata checker cannot authenticate execution evidence.
    # Promotion requires a separately reviewed executable evidence verifier.
    if evidence != {} or any(status != "unsupported" for status in features.values()):
        raise SystemExit("metadata cannot certify reactive implementation")


if __name__ == "__main__":
    validate(json.loads((ROOT / "reactive-signal-v1.json").read_text()))
    print("REACTIVE_SIGNAL_V1_PROFILE_OK", BACKEND)
