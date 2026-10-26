use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

const PROTOCOL: &str = "oreslang-ecosystem-integration";
const NOTE: &str = "Declared integration touchpoints only; no CI or runtime parity is asserted.";
const MAX_BYTES: usize = 4096;
const EXPECTED_KEYS: [&str; 7] = [
    "schemaVersion",
    "protocol",
    "repository",
    "role",
    "upstreams",
    "evidence",
    "note",
];

#[derive(Debug)]
struct StrictObject(BTreeMap<String, Value>);

struct StrictObjectVisitor;

impl<'de> Visitor<'de> for StrictObjectVisitor {
    type Value = StrictObject;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON object with unique top-level keys")
    }

    fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
    where
        M: MapAccess<'de>,
    {
        let mut values = BTreeMap::new();
        while let Some((key, value)) = map.next_entry::<String, Value>()? {
            if values.insert(key.clone(), value).is_some() {
                return Err(de::Error::custom(format!("duplicate JSON key: {key:?}")));
            }
        }
        Ok(StrictObject(values))
    }
}

impl<'de> Deserialize<'de> for StrictObject {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(StrictObjectVisitor)
    }
}

fn upstreams(repository: &str) -> Option<&'static [&'static str]> {
    match repository {
        "oreslang-source.java" => Some(&["oreslang-common-source", "oreslang-target-profiles"]),
        "oreslang-source.llvm" => Some(&["oreslang-common-source", "oreslang-target-profiles"]),
        "oreslang-source.wasm" => Some(&[
            "oreslang-source.llvm",
            "oreslang-target-profiles",
            "oreslang-wasm",
        ]),
        "oreslang-source.js" => Some(&["oreslang-common-source", "oreslang-target-profiles"]),
        "oreslang-source.hdl" => Some(&["oreslang-common-source", "oreslang-target-profiles"]),
        "oreslang-source.forge" => Some(&["oreslang-common-source", "oreslang-target-profiles"]),
        "oreslang-source.net" => Some(&["oreslang-common-source", "oreslang-target-profiles"]),
        _ => None,
    }
}

fn invalid(message: impl Into<String>) -> String {
    message.into()
}

fn verify_bytes(raw: &[u8], repository_name: &str) -> Result<BTreeMap<String, Value>, String> {
    let expected_upstreams = upstreams(repository_name).ok_or_else(|| invalid("unknown source repository"))?;
    if raw.is_empty() || raw.len() > MAX_BYTES {
        return Err(invalid("manifest is empty or oversized"));
    }
    let decoded = std::str::from_utf8(raw).map_err(|_| invalid("manifest must be valid UTF-8"))?;
    if decoded.starts_with('﻿') {
        return Err(invalid("UTF-8 BOM is prohibited"));
    }

    let mut deserializer = serde_json::Deserializer::from_str(decoded);
    let StrictObject(value) = StrictObject::deserialize(&mut deserializer)
        .map_err(|_| invalid("invalid JSON"))?;
    deserializer.end().map_err(|_| invalid("invalid JSON"))?;

    let actual_keys: BTreeSet<&str> = value.keys().map(String::as_str).collect();
    let expected_keys: BTreeSet<&str> = EXPECTED_KEYS.into_iter().collect();
    if actual_keys != expected_keys {
        return Err(invalid("manifest must contain exactly the seven declared keys"));
    }

    match value.get("schemaVersion") {
        Some(Value::Number(number)) if number.as_i64() == Some(1) => {}
        _ => return Err(invalid("unsupported schema version")),
    }
    match value.get("protocol") {
        Some(Value::String(protocol)) if protocol == PROTOCOL => {}
        _ => return Err(invalid("unsupported protocol")),
    }
    match value.get("repository") {
        Some(Value::String(repository))
            if repository == &format!("ores-truffle-oreslang/{repository_name}") => {}
        _ => return Err(invalid("repository identity mismatch")),
    }
    match value.get("role") {
        Some(Value::String(role)) if role == "compiler" => {}
        _ => return Err(invalid("unexpected integration role")),
    }

    let observed_upstreams = match value.get("upstreams") {
        Some(Value::Array(items)) => {
            let mut observed = Vec::with_capacity(items.len());
            for item in items {
                match item {
                    Value::String(item) => observed.push(item.as_str()),
                    _ => return Err(invalid("upstreams must be a string array")),
                }
            }
            observed
        }
        _ => return Err(invalid("upstreams must be a string array")),
    };
    if observed_upstreams.as_slice() != expected_upstreams {
        return Err(invalid(
            "unexpected, reordered, or duplicate upstream dependencies",
        ));
    }

    match value.get("evidence") {
        Some(Value::String(evidence)) if evidence == "not-attested" => {}
        _ => return Err(invalid("unverified parity/CI attestation is forbidden")),
    }
    match value.get("note") {
        Some(Value::String(note)) if note == NOTE => {}
        _ => return Err(invalid("evidence disclaimer was changed")),
    }

    Ok(value)
}

fn verify_repository(root: &Path) -> Result<String, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("invalid repository root: {e}"))?;
    let expected_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid("repository root has no UTF-8 name"))?
        .to_string();
    let manifest = root.join(".oreslang").join("integration.json");
    let metadata = fs::symlink_metadata(&manifest).map_err(|_| invalid("manifest missing or symlinked"))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(invalid("manifest missing or symlinked"));
    }
    if metadata.len() as usize > MAX_BYTES {
        return Err(invalid("manifest exceeds size limit"));
    }
    let raw = fs::read(&manifest).map_err(|e| format!("cannot read manifest: {e}"))?;
    verify_bytes(&raw, &expected_name)?;
    Ok(expected_name)
}

fn parse_root() -> Result<PathBuf, String> {
    let mut args = env::args_os().skip(1);
    let mut root = PathBuf::from(".");
    while let Some(arg) = args.next() {
        if arg == "--repository-root" {
            root = args
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| invalid("--repository-root requires a path"))?;
        } else {
            return Err(format!("unknown argument: {}", arg.to_string_lossy()));
        }
    }
    Ok(root)
}

fn main() {
    let result = parse_root().and_then(|root| verify_repository(&root));
    match result {
        Ok(name) => {
            println!(
                "integration declaration verified: {name}; evidence remains not-attested"
            );
        }
        Err(error) => {
            eprintln!("integration manifest DENIED: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = env::temp_dir().join(format!("ores-js-manifest-{}-{stamp}-{n}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn manifest(repo: &str, evidence: &str, note: &str, upstream_values: &[&str]) -> Vec<u8> {
        let upstream_json = upstream_values
            .iter()
            .map(|value| serde_json::to_string(value).unwrap())
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"schemaVersion\":1,\"protocol\":{protocol},\"repository\":{repository},\"role\":\"compiler\",\"upstreams\":[{upstreams}],\"evidence\":{evidence},\"note\":{note}}}",
            protocol = serde_json::to_string(PROTOCOL).unwrap(),
            repository = serde_json::to_string(&format!("ores-truffle-oreslang/{repo}")).unwrap(),
            upstreams = upstream_json,
            evidence = serde_json::to_string(evidence).unwrap(),
            note = serde_json::to_string(note).unwrap(),
        )
        .into_bytes()
    }

    fn valid(repo: &str) -> Vec<u8> {
        manifest(repo, "not-attested", NOTE, upstreams(repo).unwrap())
    }

    #[test]
    fn all_seven_source_backends() {
        let repos = [
            "oreslang-source.java",
            "oreslang-source.llvm",
            "oreslang-source.wasm",
            "oreslang-source.js",
            "oreslang-source.hdl",
            "oreslang-source.forge",
            "oreslang-source.net",
        ];
        for repo in repos {
            let verified = verify_bytes(&valid(repo), repo).unwrap();
            assert_eq!(verified["evidence"], Value::String("not-attested".into()));
        }
    }

    #[test]
    fn duplicate_key_rejected() {
        let mut raw = valid("oreslang-source.java");
        raw.pop();
        raw.extend_from_slice(b",\"evidence\":\"not-attested\"}");
        assert!(verify_bytes(&raw, "oreslang-source.java").is_err());
    }

    #[test]
    fn unsupported_repo_rejected() {
        assert!(verify_bytes(&valid("oreslang-source.java"), "oreslang-source.invented").is_err());
    }

    #[test]
    fn repository_mismatch_rejected() {
        assert!(verify_bytes(&valid("oreslang-source.llvm"), "oreslang-source.java").is_err());
    }

    #[test]
    fn evidence_claims_rejected() {
        for claim in ["passed", "attested", "verified"] {
            let raw = manifest(
                "oreslang-source.java",
                claim,
                NOTE,
                upstreams("oreslang-source.java").unwrap(),
            );
            assert!(verify_bytes(&raw, "oreslang-source.java").is_err());
        }
    }

    #[test]
    fn upstream_injection_and_reordering_rejected() {
        let cases: &[&[&str]] = &[
            &[],
            &["oreslang-target-profiles", "oreslang-common-source"],
            &["oreslang-common-source", "oreslang-common-source"],
            &["../oreslang-target-profiles"],
            &["oreslang-common-source", "oreslang-target-profiles", "other"],
        ];
        for dependencies in cases {
            let raw = manifest("oreslang-source.java", "not-attested", NOTE, dependencies);
            assert!(verify_bytes(&raw, "oreslang-source.java").is_err());
        }
    }

    #[test]
    fn unknown_and_missing_fields_rejected() {
        let raw = String::from_utf8(valid("oreslang-source.java")).unwrap();
        let unknown = raw.replacen("}", ",\"runtimeParity\":true}", 1);
        assert!(verify_bytes(unknown.as_bytes(), "oreslang-source.java").is_err());
        let missing = raw.replace(&format!(",\"note\":{}", serde_json::to_string(NOTE).unwrap()), "");
        assert!(verify_bytes(missing.as_bytes(), "oreslang-source.java").is_err());
    }

    #[test]
    fn schema_bool_is_not_integer() {
        let raw = String::from_utf8(valid("oreslang-source.java"))
            .unwrap()
            .replace("\"schemaVersion\":1", "\"schemaVersion\":true");
        assert!(verify_bytes(raw.as_bytes(), "oreslang-source.java").is_err());
    }

    #[test]
    fn invalid_json_constant_rejected() {
        let raw = String::from_utf8(valid("oreslang-source.java"))
            .unwrap()
            .replace("\"schemaVersion\":1", "\"schemaVersion\":NaN");
        assert!(verify_bytes(raw.as_bytes(), "oreslang-source.java").is_err());
    }

    #[test]
    fn size_encoding_bom_and_note_rejected() {
        assert!(verify_bytes(&vec![b' '; MAX_BYTES + 1], "oreslang-source.java").is_err());

        let mut bad_utf8 = vec![0xff];
        bad_utf8.extend(valid("oreslang-source.java"));
        assert!(verify_bytes(&bad_utf8, "oreslang-source.java").is_err());

        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend(valid("oreslang-source.java"));
        assert!(verify_bytes(&bom, "oreslang-source.java").is_err());

        let bad_note = manifest(
            "oreslang-source.java",
            "not-attested",
            "CI parity is asserted.",
            upstreams("oreslang-source.java").unwrap(),
        );
        assert!(verify_bytes(&bad_note, "oreslang-source.java").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn cli_rejects_symlinked_manifest() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new();
        let root = temp.0.join("oreslang-source.java");
        fs::create_dir_all(root.join(".oreslang")).unwrap();
        let external = temp.0.join("external.json");
        fs::write(&external, valid("oreslang-source.java")).unwrap();
        symlink(&external, root.join(".oreslang/integration.json")).unwrap();
        assert!(verify_repository(&root).is_err());
    }
}
