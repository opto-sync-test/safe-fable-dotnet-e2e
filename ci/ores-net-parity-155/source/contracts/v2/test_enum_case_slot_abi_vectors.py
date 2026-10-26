"""Cross-backend EOS2 *host policy* golden conformance, not guest execution.

A passing fixture never implies Oreslang accepts Foo.A in parameter types.
It pins deterministic Java/C++ static slot bytes for future backend parity.
"""
import json
import pathlib
import unittest

FILE = pathlib.Path(__file__).with_name("enum_case_slot_abi_vectors.json")
SCALARS = frozenset(("bool", "int", "string", "float"))
JAVA_WHITESPACE = {0x1680, 0x2028, 0x2029, 0x205f, 0x3000}
JAVA_WHITESPACE.update(range(0x2000, 0x2007))
JAVA_WHITESPACE.update(range(0x2008, 0x200b))
# Reject all Unicode Space_Separator values, including NBSP, U+2007 and U+202F.
SPACE_CHARS = {0x00a0, 0x2007, 0x202f}
MAX_ID_BYTES = 512
BIDI = {0x061c, 0x2060, 0xfeff}
BIDI.update(range(0x200b, 0x2010))
BIDI.update(range(0x202a, 0x202f))
BIDI.update(range(0x2066, 0x206a))


def valid_id(value):
    if not isinstance(value, str) or not value or all(
            ord(c) <= 0x20 or ord(c) in JAVA_WHITESPACE for c in value):
        raise ValueError("empty nominal identity")
    if len(value) > MAX_ID_BYTES:
        raise ValueError("nominal identity character budget exceeded")
    for c in value:
        cp = ord(c)
        if cp in BIDI or cp in JAVA_WHITESPACE or cp in SPACE_CHARS or cp <= 0x20 or 0x7f <= cp <= 0x9f:
            raise ValueError("control or invisible codepoint")
        if 0xd800 <= cp <= 0xdfff:
            raise ValueError("malformed surrogate")
    if len(value.encode("utf-8", errors="strict")) > MAX_ID_BYTES:
        raise ValueError("nominal identity UTF-8 budget exceeded")
    return value


def qualified(value):
    valid_id(value)
    if "." not in value or value.startswith(".") or value.endswith(".") or ".." in value:
        raise ValueError("unqualified enum symbol")
    return value


def encode(value):
    raw = valid_id(value).encode("utf-8", errors="strict")
    return str(len(raw)) + "_" + raw.hex()


def symbol(v):
    if v["domain"] not in ("MODULE", "INSTANCE", "STATIC"):
        raise ValueError("invalid callable domain")
    qualified(v["owner"])
    valid_id(v["name"])
    params = v["params"]
    if len(params) > 64:
        raise ValueError("signature arity bound")
    result = ("eos2" + encode(v["domain"]) + encode(v["owner"])
              + encode(v["name"]) + "a" + str(len(params)) + "_")
    for p in params:
        kind = p["kind"]
        if kind == "FIXED":
            if p["identity"] not in SCALARS or "case" in p:
                raise ValueError("unknown fixed scalar")
            result += "F" + encode(p["identity"])
        elif kind in ("ENUM", "CASE"):
            qualified(p["identity"])
            if kind == "ENUM":
                if "case" in p:
                    raise ValueError("whole enum cannot carry a case")
                result += "E" + encode(p["identity"])
            else:
                result += "C" + encode(p["identity"]) + encode(p["case"])
        else:
            raise ValueError("unknown parameter kind")
    return result


class EnumCaseSlotABI(unittest.TestCase):
    def test_all_golden_symbols_and_pairwise_injectivity(self):
        document = json.loads(FILE.read_text(encoding="utf-8"))
        self.assertEqual("enum-case-slot-abi-v2", document["version"])
        self.assertEqual("host-reference-only-not-guest-executable", document["status"])
        self.assertEqual({"max_parameters": 64, "max_candidates": 128,
                          "max_enum_cases": 1024, "max_registered_enums": 4096,
                          "max_identity_utf8_bytes": 512},
                         document["bounds"])
        expected = set()
        for vector in document["vectors"]:
            with self.subTest(vector=vector["id"]):
                actual = symbol(vector)
                self.assertEqual(vector["expected"], actual)
                self.assertNotIn(actual, expected)
                expected.add(actual)
        self.assertGreaterEqual(len(expected), 8)

    def test_malformed_ids_are_not_abi_keys(self):
        golden = json.loads(FILE.read_text(encoding="utf-8"))["vectors"][0]
        for value in ("", ".Foo", "root..Foo", "root.Foo.", "root.\u202eFoo",
                      "root.\u200dFoo", "root.\u0080Foo", "root.\ufeffFoo"):
            candidate = {**golden, "params": [
                {"kind": "CASE", "identity": value, "case": "A"},
                {"kind": "FIXED", "identity": "int"}]}
            with self.subTest(value=repr(value)):
                with self.assertRaises(ValueError):
                    symbol(candidate)

    def test_invisible_space_separators_and_long_names_fail_closed(self):
        for char in ("\u00a0", "\u2007", "\u202f"):
            with self.subTest(codepoint=repr(char)):
                with self.assertRaises(ValueError):
                    encode(char)
        for value in ("A" * 513, "é" * 300):
            with self.subTest(length=len(value)):
                with self.assertRaises(ValueError):
                    encode(value)
        self.assertEqual("512_" + "41" * 512, encode("A" * 512))

    def test_no_primitive_or_case_masquerading(self):
        golden = json.loads(FILE.read_text(encoding="utf-8"))["vectors"][0]
        for value in ("String", "i8", "User", "Foo.A", "Any", "Unknown", "void"):
            candidate = {**golden, "params": [{"kind": "FIXED", "identity": value}]}
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    symbol(candidate)


if __name__ == "__main__":
    unittest.main()
