#!/usr/bin/env python3
"""Executable .NET-source -> shared static-facts/v0 smoke. No cross-org clones.

Requires a locally installed .NET 10 SDK and an already built Release compiler:
  dotnet build compiler/Ores.Net.Compiler/Ores.Net.Compiler.csproj -c Release
  python3 scripts/verify_net_static_facts_v0.py
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / "compiler/Ores.Net.Compiler/Ores.Net.Compiler.csproj"
FIELDS = {
    "version", "unit", "procedures", "edges", "taint_sources",
    "flows", "sinks", "permission_checks",
}
EMPTY_EFFECTS = ("edges", "taint_sources", "flows", "sinks", "permission_checks")


def invoke(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["dotnet", "run", "--no-build", "-c", "Release", "--project",
         str(PROJECT), "--", *args],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
        errors="replace", check=False, timeout=90,
    )


def require(condition: bool, description: str) -> None:
    if not condition:
        raise AssertionError(description)


def accepted(mode: str, path: Path) -> dict:
    completed = invoke(mode, str(path))
    require(completed.returncode == 0,
            f"{mode} rejected {path.name}: {completed.stderr[:500]}")
    try:
        facts = json.loads(completed.stdout)
    except (ValueError, TypeError) as exc:
        raise AssertionError("CLI output is not a single JSON document") from exc
    require(type(facts) is dict and set(facts) == FIELDS,
            "unexpected or missing common-v0 JSON top-level fields")
    require(facts["version"] == "ores-static-facts/v0", "wrong v0 version")
    expected_unit = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    require(facts["unit"] == expected_unit, "exact-byte source SHA-256 changed")
    require(type(facts["procedures"]) is list and len(facts["procedures"]) == 1,
            "unexpected procedure set")
    proc = facts["procedures"][0]
    require(set(proc) == {"id", "loops"} and proc["id"] == "__root__.main/0",
            "invalid or noncanonical main/0")
    require(type(proc["loops"]) is list and len(proc["loops"]) <= 256,
            "loop collection exceeds Rust import limit")
    for loop in proc["loops"]:
        require(set(loop) == {"id", "exit", "safepoint"} and
                loop["exit"] == "unknown" and loop["safepoint"] is False,
                "unsupported termination or safepoint proof emitted")
    for key in EMPTY_EFFECTS:
        require(facts[key] == [], f"unproved nonempty {key} fact")
    return facts


def rejected(mode: str, path: Path, expected_status: int = 1) -> None:
    completed = invoke(mode, str(path))
    require(completed.returncode == expected_status,
            f"expected {mode} to reject {path.name} with status "
            f"{expected_status}, got {completed.returncode}: "
            f"{completed.stdout[:200]} {completed.stderr[:400]}")


def main() -> None:
    fixture = ROOT / "contracts/scalar/v1/fixtures/literal-42.ores"
    require(fixture.is_file(), "checked-in scalar source missing")
    positive = accepted("static-facts", fixture)
    require(positive["procedures"][0]["loops"] == [],
            "production scalar IR invented loop facts")
    require(positive == accepted("static-facts", fixture),
            "non-deterministic scalar facts")

    with tempfile.TemporaryDirectory(prefix="ores-net-facts-") as temporary:
        work = Path(temporary)
        structured = work / "structured.ores"
        structured.write_bytes(
            b"fnc main():int{let int i=0;while i<2{i=i+1;}return i;}"
        )
        tree = accepted("static-facts-structured", structured)
        require(tree["procedures"][0]["loops"] ==
                [{"id": "L1", "exit": "unknown", "safepoint": False}],
                "unknown while-loop semantics were lost")
        rejected("static-facts", structured)

        bad = work / "missing.ores"
        bad.write_bytes(b"fnc main():int{return missing;}")
        rejected("static-facts", bad)
        rejected("static-facts-structured", bad)

        wrong = work / "scalar.txt"
        wrong.write_bytes(fixture.read_bytes())
        rejected("static-facts", wrong)

        bom = work / "bom.ores"
        bom.write_bytes(b"\xef\xbb\xbf" + fixture.read_bytes())
        rejected("static-facts", bom)
        rejected("static-facts-structured", bom)

        invalid = work / "malformed.ores"
        invalid.write_bytes(b"\xff\xfe\xff")
        rejected("static-facts", invalid)

        # Strict certification requests must never be accepted by an
        # advisory-only compiler-facts export command.
        strict = invoke("static-facts", str(fixture), "hard")
        require(strict.returncode == 2,
                f"unexpected strict-profile argument status: {strict.returncode}")

        modified = work / "modified.ores"
        modified.write_bytes(fixture.read_bytes() + b"\n")
        require(accepted("static-facts", modified)["unit"] != positive["unit"],
                "distinct byte streams share the same unit identity")

    print("PASS: .NET 10 executable static-facts v0 source/byte/schema smoke")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, OSError, subprocess.TimeoutExpired) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
