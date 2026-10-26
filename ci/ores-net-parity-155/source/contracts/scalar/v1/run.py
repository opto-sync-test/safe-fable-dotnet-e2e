#!/usr/bin/env python3
"""Fail-closed source fixture gate for Oreslang bootstrap backends.

admission is compiler acceptance ONLY; stdout-i64 also executes the guest.
Do not interpret admission as compiled guest/runtime parity.
"""
import argparse
import hashlib
import json
import os
import stat
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
MAX_OUTPUT_BYTES = 65536
MAX_FIXTURE_BYTES = 1048576

# Contract v1 is a closed reference inventory. New cases require a reviewed
# revision, not silent substitution/shrinkage under the same schema version.
EXPECTED_V1_CASES = {
    "scalar.literal-42": ("accept", "42"),
    "scalar.precedence": ("accept", "28"),
    "scalar.unary": ("accept", "-21"),
    "scalar.i64-min": ("accept", "-9223372036854775808"),
    "scalar.i64-max": ("accept", "9223372036854775807"),
    "scalar.i64-max-minus-one": ("accept", "9223372036854775806"),
    "reject.unknown": ("reject", None),
    "reject.division": ("reject", None),
    "reject.actor": ("reject", None),
    "reject.async": ("reject", None),
    "reject.structural": ("reject", None),
}


def reject_duplicate_json_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate manifest JSON key: " + key)
        result[key] = value
    return result


def read_bounded_regular_fixture(source):
    """Read a fixture through its opened file descriptor, never a FIFO.

    POSIX no-follow/nonblocking flags prevent symlink and FIFO substitutions
    from turning a manifest check into an unbounded read or a hang. Windows
    uses regular-file lstat/fstat checks; these are not an atomic trust boundary.
    """
    original = source.lstat()
    if not stat.S_ISREG(original.st_mode) or original.st_nlink != 1:
        raise ValueError("source fixture must be a unique regular file")
    if not 0 < original.st_size <= MAX_FIXTURE_BYTES:
        raise ValueError("invalid source length")
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(source, flags)
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise ValueError("fixture replaced by nonregular file")
        if not same_fixture_identity(original, opened):
            raise ValueError("fixture changed before read")
        data = stream.read(MAX_FIXTURE_BYTES + 1)
        after = os.fstat(stream.fileno())
        if not same_fixture_identity(opened, after, descriptor_pair=True):
            raise ValueError("fixture changed during read")
    final = source.lstat()
    if not same_fixture_identity(after, final):
        raise ValueError("fixture path changed during read")
    if not 0 < len(data) <= MAX_FIXTURE_BYTES:
        raise ValueError("invalid source length")
    return data


def same_fixture_identity(before, after, descriptor_pair=False):
    fields = ["st_dev", "st_ino", "st_mode", "st_size", "st_nlink", "st_mtime_ns"]
    # Windows Python can expose creation time through path stat and modification
    # time through descriptor stat as st_ctime_ns. Compare it only within the
    # same descriptor API; retain full ctime checks on POSIX.
    # https://docs.python.org/3/library/os.html#os.stat_result.st_ctime_ns
    if os.name != "nt" or descriptor_pair:
        fields.append("st_ctime_ns")
    return all(getattr(before, attr) == getattr(after, attr) for attr in fields)


def load_suite():
    # The manifest is as security-sensitive as each source fixture: reject
    # FIFO/symlink/device substitution and oversized files before parsing.
    suite_bytes = read_bounded_regular_fixture(HERE / "cases.json")
    suite = json.loads(suite_bytes, object_pairs_hook=reject_duplicate_json_keys)
    if not isinstance(suite, dict) or set(suite) != {"schema_version", "cases"} or suite["schema_version"] != "1.0.0":
        raise ValueError("unsupported manifest fields or version")
    if not isinstance(suite["cases"], list) or not (1 <= len(suite["cases"]) <= 100):
        raise ValueError("invalid case inventory")
    digest = hashlib.sha256(suite_bytes)
    seen, declared = set(), set()
    fixture_root = HERE / "fixtures"
    if fixture_root.is_symlink() or not fixture_root.is_dir():
        raise ValueError("fixture directory must be an ordinary directory")
    for case in suite["cases"]:
        if not isinstance(case, dict) or set(case) not in ({"id", "file", "kind", "value"}, {"id", "file", "kind"}):
            raise ValueError("unexpected case fields")
        cid, filename, kind = case["id"], case["file"], case["kind"]
        if not isinstance(cid, str) or not re.fullmatch(r"[a-z][a-z0-9.-]{1,79}", cid) or cid in seen:
            raise ValueError("invalid or duplicate case id")
        seen.add(cid)
        if not isinstance(filename, str) or not re.fullmatch(r"fixtures/[a-z0-9-]+\.ores", filename):
            raise ValueError("invalid fixture filename")
        if filename in declared:
            raise ValueError("duplicate source fixture: " + filename)
        source = HERE / filename
        if source.is_symlink() or source.resolve().parent != fixture_root.resolve():
            raise ValueError("fixture path escapes fixture root")
        data = read_bounded_regular_fixture(source)
        if b"\x00" in data:
            raise ValueError("embedded NUL in source fixture")
        data.decode("utf-8", errors="strict")
        digest.update(filename.encode("ascii") + b"\x00" + data)
        declared.add(filename)
        if kind == "accept":
            value = case.get("value")
            if not isinstance(value, str) or not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value):
                raise ValueError("positive case requires canonical decimal value")
            if not (-(1 << 63) <= int(value) < (1 << 63)):
                raise ValueError("expected i64 outside range")
        elif kind != "reject" or "value" in case:
            raise ValueError("negative case may not specify a value")
        expected = EXPECTED_V1_CASES.get(cid)
        if expected is None or (kind, case.get("value")) != expected:
            raise ValueError("unknown or redefined v1 case: " + cid)
        suffix = cid.split(".", 1)[1]
        expected_file = "fixtures/" + ("reject-" if kind == "reject" else "") + suffix + ".ores"
        if filename != expected_file:
            raise ValueError("v1 case filename does not match its identity")
    if seen != set(EXPECTED_V1_CASES):
        raise ValueError("v1 case inventory changed")
    disk = {"fixtures/" + p.name for p in fixture_root.iterdir()}
    if disk != declared:
        raise ValueError("orphan/missing fixture: " + str(sorted(disk ^ declared)))
    return suite, digest.hexdigest()


def snapshot_suite(suite, verified_digest, destination):
    """Stage byte-verified private copies before launching a compiler."""
    snapshot = destination / "fixtures"
    snapshot.mkdir(mode=0o700)
    h = hashlib.sha256(read_bounded_regular_fixture(HERE / "cases.json"))
    for case in suite["cases"]:
        original = HERE / case["file"]
        data = read_bounded_regular_fixture(original)
        h.update(case["file"].encode("ascii") + b"\x00" + data)
        target = snapshot / Path(case["file"]).name
        with target.open("xb") as stream:
            stream.write(data)
    if h.hexdigest() != verified_digest:
        raise ValueError("fixture corpus changed during snapshot")
    return snapshot


# Match independently reviewed frontend diagnostics for each negative case.
# A backend-prefixed IO/launcher error is NEVER semantic rejection evidence.
NEGATIVE_DIAGNOSTICS = {
    "forge": {
        "reject.unknown": r"oresforge: expected integer at byte (?P<offset>[0-9]+)",
        "reject.division": r"oresforge: division requires float result lowering; unsupported in the i64 source subset at byte (?P<offset>[0-9]+)",
        "reject.actor": r"oresforge: unexpected token at byte (?P<offset>[0-9]+)",
        "reject.async": r"oresforge: unexpected token at byte (?P<offset>[0-9]+)",
        "reject.structural": r"oresforge: expected integer at byte (?P<offset>[0-9]+)",
    },
    "net": {
        "reject.unknown": r"oresnet: Expected integer at offset (?P<offset>[0-9]+)",
        "reject.division": r"oresnet: Division requires float result lowering; unsupported in the i64 source subset",
        "reject.actor": r"oresnet: Expected 'fnc' at offset (?P<offset>[0-9]+)",
        "reject.async": r"oresnet: Expected 'fnc' at offset (?P<offset>[0-9]+)",
        "reject.structural": r"oresnet: Expected integer at offset (?P<offset>[0-9]+)",
    },
}


def capture_bounded(argv, timeout):
    """Capture bounded stdout/stderr while a process is running.

    A delayed post-exit size check can exhaust disk. Reader threads drain
    anonymous pipes in small chunks, storing at most MAX_OUTPUT_BYTES + 1
    per stream. On overflow or timeout, kill the isolated POSIX process group
    (or the direct child on Windows). No shell or compiler credentials.
    """
    popen_kwargs = {"stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE,
                    "stderr": subprocess.PIPE}
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True
    elif os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    proc = subprocess.Popen(argv, **popen_kwargs)
    outputs = [bytearray(), bytearray()]
    overflow = threading.Event()
    read_errors = []

    def reader(stream, buffer):
        try:
            while True:
                chunk = os.read(stream.fileno(), 4096)
                if not chunk:
                    break
                room = MAX_OUTPUT_BYTES + 1 - len(buffer)
                if room > 0:
                    buffer.extend(chunk[:room])
                if len(buffer) > MAX_OUTPUT_BYTES:
                    overflow.set()
                    break
        except OSError as exc:
            read_errors.append(exc)
            overflow.set()
        finally:
            stream.close()

    threads = [threading.Thread(target=reader, args=(pipe, buf), daemon=True)
               for pipe, buf in zip((proc.stdout, proc.stderr), outputs)]
    for thread in threads:
        thread.start()

    def kill_group():
        if os.name == "posix":
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif proc.poll() is None:
            proc.kill()

    deadline = time.monotonic() + timeout
    try:
        while True:
            if overflow.is_set():
                if read_errors:
                    raise OSError("compiler output pipe read failed") from read_errors[0]
                return None, b"", b"", True
            if proc.poll() is not None and all(not t.is_alive() for t in threads):
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(argv, timeout)
            for thread in threads:
                thread.join(timeout=min(0.025, remaining))
        if read_errors:
            raise OSError("compiler output pipe read failed") from read_errors[0]
        return proc.returncode, bytes(outputs[0]), bytes(outputs[1]), False
    finally:
        # Also terminate descendants holding inherited pipe FDs after the
        # direct compiler process exits, preventing a stuck background writer.
        if overflow.is_set() or proc.poll() is None or any(t.is_alive() for t in threads):
            kill_group()
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            kill_group()
            proc.wait(timeout=1)
        for thread in threads:
            thread.join(timeout=0.2)


def run_case(command, source, kind, value, mode, timeout, backend=None, case_id=None):
    argv = [s.replace("{source}", str(source)) for s in command]
    try:
        returncode, stdout_bytes, stderr_bytes, exceeded = capture_bounded(argv, timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, "infrastructure: " + type(exc).__name__
    if exceeded:
        return False, "compiler output exceeded 64 KiB"
    # Invalid UTF-8 from a compiler is not admissible semantic evidence.
    try:
        stdout = stdout_bytes.decode("utf-8", "strict")
        stderr = stderr_bytes.decode("utf-8", "strict")
    except UnicodeDecodeError:
        return False, "infrastructure: invalid UTF-8 in compiler output"
    if kind == "reject":
        signature = NEGATIVE_DIAGNOSTICS.get(backend, {}).get(case_id)
        # Full-match disallows prefixed disk/launcher failures and extra errors.
        diagnostic = (re.fullmatch(signature + r"(?:\r?\n)?", stderr)
                      if signature is not None else None)
        # A parser offset outside the immutable fixture is an unrelated or
        # fabricated failure, not source-specific negative evidence.
        offset = diagnostic.groupdict().get("offset") if diagnostic else None
        offset_valid = offset is None or int(offset) <= source.stat().st_size
        success = (returncode == 1 and not stdout and
                   diagnostic is not None and offset_valid)
    elif mode == "stdout-i64":
        success = (returncode == 0 and stderr == "" and
                   stdout in (value, value + "\n", value + "\r\n"))
    else:
        # .NET `check` must actually pass its typed-IR admission path. An
        # arbitrary exit-zero command is not proof of parser/type acceptance.
        net_admission = "Oreslang subset syntax and typed OresIR: OK"
        stdout_ok = (stdout.strip() == net_admission) if backend == "net" else True
        success = returncode == 0 and stdout_ok and not stderr.strip()
    return success, ("exit=" + str(returncode) + " stderr=" + repr(stderr[:160])
                     + " stdout=" + repr(stdout[:160]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=("java", "llvm", "net", "forge", "wasm"), required=True)
    ap.add_argument("--mode", choices=("admission", "stdout-i64"), required=True)
    ap.add_argument("--command", required=True, help="argv template with exactly one {source}")
    ap.add_argument("--revision", help="exact tested Git commit SHA")
    ap.add_argument("--report", type=Path)
    ap.add_argument("--timeout", type=int, default=20)
    opts = ap.parse_args()
    # Only independently reviewed backend/mode pairs can issue this evidence.
    # In particular a generic exit-zero is not admissible Java/LLVM/Wasm proof.
    supported = {"forge": "stdout-i64", "net": "admission"}
    if supported.get(opts.backend) != opts.mode:
        ap.error("unsupported backend/mode evidence pair")
    if opts.revision and not re.fullmatch(r"[0-9a-f]{40}", opts.revision):
        ap.error("--revision must be a full lowercase Git commit SHA")
    if opts.report and not opts.revision:
        ap.error("--report requires --revision; unpinned execution evidence is not publishable")
    if not (1 <= opts.timeout <= 300):
        ap.error("--timeout must be 1..300 seconds")
    cmd = shlex.split(opts.command)
    if not cmd or sum(part.count("{source}") for part in cmd) != 1:
        ap.error("--command must contain exactly one {source} placeholder")
    suite, digest = load_suite()
    records, failures = [], 0
    with tempfile.TemporaryDirectory(prefix="ores-scalar-verified-") as work:
        snapshot = snapshot_suite(suite, digest, Path(work))
        for case in suite["cases"]:
            source = snapshot / Path(case["file"]).name
            ok, details = run_case(cmd, source, case["kind"], case.get("value"),
                                   opts.mode, opts.timeout, opts.backend, case["id"])
            records.append({"id": case["id"], "status": "pass" if ok else "fail"})
            if not ok:
                failures += 1
            print(("PASS" if ok else "FAIL") + " " + case["id"] + ("" if ok else ": " + details), flush=True)
    if opts.report:
        opts.report.parent.mkdir(parents=True, exist_ok=True)
        opts.report.write_text(json.dumps({"schema_version": "1.0.0", "backend": opts.backend,
            "evidence_level": "source-executed-scalar" if opts.mode == "stdout-i64" else "compiler-admission-only",
            "source_revision": opts.revision, "suite_sha256": digest, "results": records}, indent=2) + "\n")
    print(f"SCALAR_PARITY {opts.backend} mode={opts.mode} cases={len(records)} failures={failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, UnicodeError, KeyError) as exc:
        print("SCALAR_PARITY_INFRASTRUCTURE_ERROR: " + str(exc), file=sys.stderr)
        sys.exit(2)
