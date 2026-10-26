"""Nullary enum tag32 ABI v2 golden fingerprints, source-free fixture validation.

This file asserts shared on-disk *host-only* vectors. It does not compile
guest enum programs or certify source/typechecker/ownership binding.
"""
import hashlib
import json
import pathlib
import struct
import unittest

HERE = pathlib.Path(__file__).resolve().parent
FIXTURE = HERE / "enum_tag32_schema_v2_vectors.json"


def field(text):
    raw = text.encode("utf-8")
    if not raw or len(raw) > 512:
        raise ValueError("empty or unbounded ABI field")
    return struct.pack(">I", len(raw)) + raw


def schema_bytes(identity, visibility, cases):
    if visibility not in ("private", "public"):
        raise ValueError("unsupported export visibility")
    if "." not in identity or identity.startswith(".") or identity.endswith("."):
        raise ValueError("unqualified enum symbol")
    if not 1 <= len(cases) <= 1024:
        raise ValueError("invalid AOT enum case count")
    out = bytearray(field("ores-nullary-enum-tag32-schema-v2"))
    out.extend(field(identity))
    out.extend(field(visibility))
    out.extend(field(str(len(cases))))
    previous = 0
    names = set()
    for case in cases:
        tag = case["tag"]
        name = case["name"]
        if not isinstance(tag, int) or isinstance(tag, bool) or not 1 <= tag <= 0x7fffffff:
            raise ValueError("invalid i32 enum tag")
        if tag <= previous or name in names:
            raise ValueError("unordered or duplicated enum case")
        if not name or not (name[0].isascii() and
                           (name[0].isalpha() or name[0] == "_")):
            raise ValueError("nonportable enum case")
        if not all(ch.isascii() and (ch.isalnum() or ch == "_") for ch in name):
            raise ValueError("nonportable enum case")
        previous = tag
        names.add(name)
        out.extend(field(name))
        out.extend(struct.pack(">I", tag))
    return bytes(out)


class NullaryTag32Golden(unittest.TestCase):
    def test_exact_public_private_vectors(self):
        j = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual("nullary-enum-tag32-schema-v2", j["version"])
        self.assertEqual("host-only-not-guest-executable", j["status"])
        self.assertEqual({"private", "public"},
                         {layout["visibility"] for layout in j["layouts"]})
        for layout in j["layouts"]:
            with self.subTest(visibility=layout["visibility"]):
                wire = schema_bytes(j["qualified_enum_id"],
                                    layout["visibility"], j["cases"])
                self.assertEqual(layout["canonical_bytes_hex"], wire.hex())
                self.assertEqual(layout["schema_sha256"],
                                 hashlib.sha256(wire).hexdigest())
        self.assertNotEqual(j["layouts"][0]["schema_sha256"],
                            j["layouts"][1]["schema_sha256"])

    def test_schema_changes_do_not_coalesce(self):
        j = json.loads(FIXTURE.read_text(encoding="utf-8"))
        original = schema_bytes(j["qualified_enum_id"], "private", j["cases"])
        exported = schema_bytes(j["qualified_enum_id"], "public", j["cases"])
        renamed = schema_bytes(j["qualified_enum_id"] + "2", "private", j["cases"])
        tag_changed = [dict(item) for item in j["cases"]]
        tag_changed[-1]["tag"] += 1
        modified = schema_bytes(j["qualified_enum_id"], "private", tag_changed)
        self.assertEqual(4, len({original, exported, renamed, modified}))

    def test_invalid_tags_and_nonportable_names_are_denied(self):
        for cases in ([{"name": "A", "tag": 0}],
                      [{"name": "A", "tag": 2147483648}],
                      [{"name": "A", "tag": 5}, {"name": "B", "tag": 5}],
                      [{"name": "Café", "tag": 1}]):
            with self.subTest(cases=cases):
                with self.assertRaises(ValueError):
                    schema_bytes("root.Foo", "private", cases)


if __name__ == "__main__":
    unittest.main()
