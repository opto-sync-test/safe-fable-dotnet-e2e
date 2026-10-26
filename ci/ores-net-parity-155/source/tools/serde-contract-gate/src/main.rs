//! Static Sendable/Serializable contract pin. NOT runtime or cross-backend parity.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, env, fs, path::{Path, PathBuf}};

const EXPECTED_SHA256: &str = "0057fa040cd23857ee14b232472c5056a74e11c9528b8b06dbe348023d97106d";
const RELATIVE_PATH: &str = "contracts/v1/serde_boundary_v1.json";

fn exact_string_set(value: &Value, expected: &[&str]) -> bool {
    let Some(array) = value.as_array() else { return false };
    let Some(names) = array.iter().map(Value::as_str).collect::<Option<Vec<_>>>() else {
        return false;
    };
    names.len() == expected.len()
        && names.into_iter().collect::<BTreeSet<_>>()
            == expected.iter().copied().collect::<BTreeSet<_>>()
}

const REQUIRED_INVARIANTS: [&str; 12] = [
    "sendable_is_not_serializable",
    "serializable_is_not_sendable",
    "shared_safe_is_not_sendable",
    "codec_objects_are_not_data",
    "source_imports_and_generics_are_resolved_before_admission",
    "incoming_bytes_never_select_type_or_codec",
    "schema_hash_is_not_an_authentication_mac",
    "receiver_pins_schema_before_first_send",
    "failed_admission_does_not_consume_sender_ownership",
    "partial_mailbox_admission_is_forbidden",
    "capabilities_cannot_be_nested_in_data",
    "unsupported_shapes_fail_closed",
];

fn check_semantics(doc: &Value) -> Result<(), &'static str> {
    if doc["contract"].as_str() != Some("oreslang.sendable-serializable.v1") {
        return Err("unsupported serde contract revision");
    }
    if doc["status"].as_str() != Some("normative_security_invariants_not_feature_support") {
        return Err("a normative contract is not feature support");
    }
    let boundaries = doc["boundaries"].as_object().ok_or("missing boundary map")?;
    let expected: BTreeSet<_> =
        ["actor_data", "network_data", "supervisor_control"].into_iter().collect();
    if boundaries.keys().map(String::as_str).collect::<BTreeSet<_>>() != expected {
        return Err("serde boundary categories must be distinct");
    }
    for (name, policy) in [
        ("actor_data", "reject_before_enqueue"),
        ("network_data", "reject_before_io"),
        ("supervisor_control", "reject_without_data_fallback"),
    ] {
        if boundaries[name]["unimplemented_policy"].as_str() != Some(policy) {
            return Err("unsupported or downgraded fail-closed policy");
        }
    }
    let formats = boundaries["network_data"]["formats"]
        .as_array().ok_or("network formats must be array")?;
    let formats_set: Option<BTreeSet<&str>> = formats.iter().map(Value::as_str).collect();
    if formats.len() != 3 || formats_set != Some(["json", "messagepack_v2", "protobuf"].into_iter().collect()) {
        return Err("unknown, duplicate, or missing network format");
    }
    let invariants = doc["invariants"].as_object().ok_or("missing invariants")?;
    if invariants.len() != REQUIRED_INVARIANTS.len()
        || REQUIRED_INVARIANTS.iter().any(|name| invariants.get(*name) != Some(&Value::Bool(true)))
    {
        return Err("all twelve named ownership / codec / authority invariants required");
    }
    if !exact_string_set(&boundaries["actor_data"]["requirements"], &[
        "compiler_sealed_sendable", "resolved_nominal_type",
        "receiver_pinned_codec_if_wire", "owned_snapshot_or_exclusive_move",
        "quota_before_admission", "atomic_move_commit",
    ]) || !exact_string_set(&boundaries["actor_data"]["forbid"], &[
        "borrow", "raw_pointer", "mutable_alias", "actor_ref", "actor_group_permit",
        "supervisor_control", "network_codec_object", "host_handle", "unproven_option_result",
    ]) || !exact_string_set(&boundaries["network_data"]["requirements"], &[
        "serializable_for_exact_format", "pinned_schema_and_version",
        "bounded_encode_decode", "independent_io_permission", "owned_snapshot",
    ]) || !exact_string_set(&boundaries["supervisor_control"]["requirements"], &[
        "runtime_minted_authority", "target_and_incarnation_scoped",
        "separate_control_lane", "revocation_or_replay_check",
    ]) || !exact_string_set(&boundaries["supervisor_control"]["forbid"], &[
        "actor_data_envelope", "network_data_codec", "userland_serializable",
        "userland_sendable_authorization",
    ]) {
        return Err("missing, duplicate, or downgraded exact admission policy");
    }
    let profile = &doc["wire_profile"];
    if profile["messagepack_wire_major"].as_u64() != Some(2) {
        return Err("unreviewed actor wire major version");
    }
    let fields: Option<Vec<&str>> = profile["messagepack_envelope_fields"]
        .as_array().ok_or("missing wire envelope fields")?
        .iter().map(Value::as_str).collect();
    if fields != Some(vec!["wire_major", "schema_id", "shape_sha256", "payload"]) {
        return Err("unreviewed actor frame shape");
    }
    for (kind, forbidden) in [
        ("actor_data", "unproven_option_result"),
        ("supervisor_control", "actor_data_envelope"),
    ] {
        if !boundaries[kind]["forbid"].as_array().is_some_and(|forbid|
            forbid.iter().any(|v| v.as_str() == Some(forbidden))
        ) {
            return Err("prohibited payload must reject");
        }
    }
    if !exact_string_set(&profile["portable_scalar_subset"], &[
        "bool", "signed_i64", "finite_f64", "valid_utf8",
    ]) || !exact_string_set(&profile["typed_collections"], &[
        "tuple", "fixed_array", "fixed_list", "array", "list",
    ]) || !exact_string_set(&profile["unsupported_without_verified_runtime_codec"], &[
        "option", "result", "record", "enum", "class", "unsigned_integer",
        "bigint", "decimal", "complex", "capability",
    ]) || !exact_string_set(&profile["invalid_bytes_reject"], &[
        "invalid_utf8", "noncanonical_numbers", "oversized_lengths",
        "wrong_shape", "schema_mismatch", "wire_downgrade",
    ]) {
        return Err("unsupported wire capabilities or weakened decode rejection");
    }
    let verification = &doc["verification"];
    if verification["requires_executable_code_to_claim_implemented"].as_bool() != Some(true)
        || verification["unimplemented_feature_must_be_marked_unsupported"].as_bool() != Some(true) {
        return Err("unsupported evidence or capability claim");
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn check_bytes(bytes: &[u8]) -> Result<String, String> {
    let digest = sha256_hex(bytes);
    if digest != EXPECTED_SHA256 {
        return Err(format!(
            "serde v1 contract drift: {digest}; bump contract/version intentionally"
        ));
    }
    let doc: Value = serde_json::from_slice(bytes).map_err(|e| format!("invalid JSON: {e}"))?;
    check_semantics(&doc).map_err(String::from)?;
    Ok(digest)
}

fn check(root: &Path) -> Result<String, String> {
    let path = root.join(RELATIVE_PATH);
    let metadata = fs::symlink_metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("serde contract must be a regular file".into());
    }
    if metadata.len() > 65_536 {
        return Err("serde contract exceeds 64 KiB".into());
    }
    let bytes = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    check_bytes(&bytes)
}

fn main() {
    let mut args = env::args_os().skip(1);
    let root = match args.next() {
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
        Some(flag) if flag == "--root" => match args.next() {
            Some(path) if args.next().is_none() => PathBuf::from(path),
            _ => { eprintln!("usage: oreslang-serde-contract-gate [--root PATH]"); std::process::exit(2); }
        },
        _ => { eprintln!("usage: oreslang-serde-contract-gate [--root PATH]"); std::process::exit(2); }
    };
    match check(&root) {
        Ok(digest) => println!("serde v1 STATIC contract pinned: {digest} (not executable transport parity)"),
        Err(error) => { eprintln!("serde contract DENIED: {error}"); std::process::exit(1); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pinned_contract_is_admitted() {
        assert_eq!(
            check_bytes(include_bytes!("../../../contracts/v1/serde_boundary_v1.json")),
            Ok(EXPECTED_SHA256.to_owned())
        );
    }

    #[test]
    fn byte_drift_is_rejected_before_semantic_verification() {
        let mut altered = include_bytes!("../../../contracts/v1/serde_boundary_v1.json").to_vec();
        altered.push(b' ');
        assert!(check_bytes(&altered).unwrap_err().contains("contract drift"));
    }

    #[test]
    fn rejects_unsafe_or_false_capability_claims() {
        let mut doc: Value = serde_json::from_slice(
            include_bytes!("../../../contracts/v1/serde_boundary_v1.json")
        ).unwrap();
        doc["status"] = json!("implemented");
        assert!(check_semantics(&doc).is_err());
        doc["status"] = json!("normative_security_invariants_not_feature_support");
        doc["boundaries"]["supervisor_control"]["unimplemented_policy"] = json!("fallback_to_actor_data");
        assert!(check_semantics(&doc).is_err());
    }

    #[test]
    fn rejects_deleted_invariants_and_missing_forbidden_capabilities() {
        let mut doc: Value = serde_json::from_slice(
            include_bytes!("../../../contracts/v1/serde_boundary_v1.json")
        ).unwrap();
        doc["invariants"].as_object_mut().unwrap().remove(
            "failed_admission_does_not_consume_sender_ownership"
        );
        assert!(check_semantics(&doc).is_err());
        let mut doc: Value = serde_json::from_slice(
            include_bytes!("../../../contracts/v1/serde_boundary_v1.json")
        ).unwrap();
        doc["boundaries"]["actor_data"]["forbid"].as_array_mut().unwrap().retain(
            |v| v.as_str() != Some("actor_group_permit")
        );
        assert!(check_semantics(&doc).is_err());
        let mut doc: Value = serde_json::from_slice(
            include_bytes!("../../../contracts/v1/serde_boundary_v1.json")
        ).unwrap();
        doc["wire_profile"]["invalid_bytes_reject"].as_array_mut().unwrap().retain(
            |v| v.as_str() != Some("wire_downgrade")
        );
        assert!(check_semantics(&doc).is_err());
    }

    #[test]
    fn rejects_wire_downgrade_and_false_invariants() {
        let mut doc: Value = serde_json::from_slice(
            include_bytes!("../../../contracts/v1/serde_boundary_v1.json")
        ).unwrap();
        doc["wire_profile"]["messagepack_wire_major"] = json!(1);
        assert!(check_semantics(&doc).is_err());
        doc["wire_profile"]["messagepack_wire_major"] = json!(2);
        doc["invariants"]["failed_admission_does_not_consume_sender_ownership"] = json!(false);
        assert!(check_semantics(&doc).is_err());
    }
}
