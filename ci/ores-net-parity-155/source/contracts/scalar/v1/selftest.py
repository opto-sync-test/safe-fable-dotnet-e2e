#!/usr/bin/env python3
"""Adversarial tests for the shared scalar conformance runner (no compiler required)."""
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
RUN = ROOT / "run.py"
SPEC = importlib.util.spec_from_file_location("ores_scalar_gate", RUN)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
CANONICAL_SUITE_SHA256 = "5b5d1bc00def9b3a343cb3281e0bb0be4e5ca438095f621141049e2d7a1a25b3"


class ScalarHarnessTest(unittest.TestCase):
    def setUp(self):
        self.original = runner.HERE
        self.tmp = tempfile.TemporaryDirectory(prefix="ores-scalar-audit-")
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lambda: setattr(runner, "HERE", self.original))
        runner.HERE = Path(self.tmp.name)
        (runner.HERE / "fixtures").mkdir()
        shutil.copy2(ROOT / "cases.json", runner.HERE / "cases.json")
        for case in json.loads((ROOT / "cases.json").read_text())["cases"]:
            src = ROOT / case["file"]
            shutil.copy2(src, runner.HERE / case["file"])

    def case_data(self):
        return json.loads((runner.HERE / "cases.json").read_text())

    def write(self, value):
        (runner.HERE / "cases.json").write_text(json.dumps(value) + "\n")

    def test_verified_snapshot_is_independent_of_mutated_checkout(self):
        suite, digest = runner.load_suite()
        with tempfile.TemporaryDirectory() as work:
            snapshot = runner.snapshot_suite(suite, digest, Path(work))
            saved = (snapshot / "literal-42.ores").read_bytes()
            original = runner.HERE / "fixtures" / "literal-42.ores"
            self.assertNotEqual(snapshot.resolve(), original.parent.resolve())
            self.assertEqual(saved, original.read_bytes())
            original.write_text("pub fnc main(): int { return 999; }\\n")
            self.assertEqual((snapshot / "literal-42.ores").read_bytes(), saved)

    def test_verified_snapshot_rejects_changed_corpus(self):
        suite, digest = runner.load_suite()
        original = runner.HERE / "fixtures" / "literal-42.ores"
        original.write_text("pub fnc main(): int { return 999; }\\n")
        with tempfile.TemporaryDirectory() as work:
            with self.assertRaisesRegex(ValueError, "changed during snapshot"):
                runner.snapshot_suite(suite, digest, Path(work))

    def test_duplicate_json_keys_rejected_at_every_depth(self):
        manifest = runner.HERE / "cases.json"
        raw = manifest.read_text(encoding="utf-8")
        for mutated in (
            raw.replace('"schema_version": "1.0.0",',
                        '"schema_version": "1.0.0", "schema_version": "1.0.0",', 1),
            raw.replace('"id": "scalar.literal-42",',
                        '"id": "scalar.literal-42", "id": "scalar.literal-42",', 1),
        ):
            with self.subTest(mutated=mutated[:130]):
                manifest.write_text(mutated, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "duplicate manifest JSON key"):
                    runner.load_suite()

    def test_v1_inventory_cannot_shrink_or_substitute_semantics(self):
        baseline = self.case_data()
        cases = (
            lambda d: d["cases"].pop(),
            lambda d: d["cases"][0].update(value="43"),
            lambda d: d["cases"][0].update(id="scalar.alternate-42"),
        )
        import copy
        for mutate in cases:
            doc = copy.deepcopy(baseline)
            mutate(doc)
            self.write(doc)
            with self.assertRaisesRegex(ValueError, "v1 case"):
                runner.load_suite()

    def test_backend_mode_pairs_fail_closed(self):
        import io
        from contextlib import redirect_stderr
        from unittest.mock import patch
        bad_pairs = (("wasm", "admission"), ("llvm", "admission"),
                     ("java", "stdout-i64"), ("net", "stdout-i64"),
                     ("forge", "admission"))
        for backend, mode in bad_pairs:
            with self.subTest(backend=backend, mode=mode):
                argv = ["run.py", "--backend", backend, "--mode", mode,
                        "--command", "python {source}"]
                with patch.object(sys, "argv", argv), redirect_stderr(io.StringIO()) as err:
                    with self.assertRaises(SystemExit) as failure:
                        runner.main()
                self.assertEqual(failure.exception.code, 2)
                self.assertIn("unsupported backend/mode", err.getvalue())

    def test_canonical_digest_and_inventory(self):
        suite, digest = runner.load_suite()
        self.assertEqual(digest, CANONICAL_SUITE_SHA256)
        self.assertEqual(len(suite["cases"]), 11)

    def test_non_object_manifest_or_entry_denied(self):
        for bad in [[], None, {"schema_version": "1.0.0", "cases": [None]},
                    {"schema_version": "1.0.0", "cases": [42]}]:
            with self.subTest(bad=bad):
                self.write(bad)
                with self.assertRaises(ValueError):
                    runner.load_suite()

    def test_duplicate_fixture_path_denied(self):
        suite = self.case_data()
        suite["cases"][1]["file"] = suite["cases"][0]["file"]
        self.write(suite)
        with self.assertRaisesRegex(ValueError, "duplicate source fixture"):
            runner.load_suite()

    def test_wrong_expected_value_or_extra_field_denied(self):
        suite = self.case_data()
        suite["cases"][0]["value"] = "9223372036854775808"
        self.write(suite)
        with self.assertRaisesRegex(ValueError, "outside range"):
            runner.load_suite()
        suite = self.case_data()
        suite["cases"][0]["extra"] = 1
        self.write(suite)
        with self.assertRaisesRegex(ValueError, "unexpected case fields"):
            runner.load_suite()

    def test_symlink_fixture_path_denied(self):
        path = runner.HERE / "fixtures" / "literal-42.ores"
        path.unlink()
        try:
            path.symlink_to(ROOT / "fixtures" / "literal-42.ores")
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation not permitted on this platform")
        with self.assertRaisesRegex(ValueError, "fixture path escapes"):
            runner.load_suite()

    def test_fifo_source_refused_before_open(self):
        if not hasattr(__import__("os"), "mkfifo"):
            self.skipTest("named pipes are not supported on this platform")
        import os
        path = runner.HERE / "fixtures" / "literal-42.ores"
        path.unlink()
        try:
            os.mkfifo(path)
        except OSError:
            self.skipTest("named-pipe creation unavailable")
        with self.assertRaisesRegex(ValueError, "unique regular file"):
            runner.load_suite()

    def test_directory_in_place_of_source_is_rejected(self):
        path = runner.HERE / "fixtures" / "literal-42.ores"
        path.unlink()
        path.mkdir()
        with self.assertRaisesRegex(ValueError, "unique regular file"):
            runner.load_suite()

    def test_oversized_sparse_source_rejected_before_read(self):
        path = runner.HERE / "fixtures" / "literal-42.ores"
        with path.open("wb") as stream:
            stream.truncate(runner.MAX_FIXTURE_BYTES + 1)
        with self.assertRaisesRegex(ValueError, "invalid source length"):
            runner.load_suite()

    def test_hardlinked_fixture_cannot_alias_other_source(self):
        import os
        path = runner.HERE / "fixtures" / "literal-42.ores"
        other = runner.HERE / "fixture-alias"
        try:
            os.link(path, other)
        except OSError:
            self.skipTest("hardlinks unavailable")
        with self.assertRaisesRegex(ValueError, "unique regular file"):
            runner.load_suite()

    def test_substituted_open_file_descriptor_rejected(self):
        import os
        from unittest.mock import patch
        path = runner.HERE / "fixtures" / "literal-42.ores"
        other = runner.HERE / "another-fixture.ores"
        other.write_bytes(path.read_bytes())
        real_open = os.open
        def substituted_open(filename, flags):
            if str(filename) == str(path):
                return real_open(other, flags)
            return real_open(filename, flags)
        with patch.object(runner.os, "open", side_effect=substituted_open):
            with self.assertRaisesRegex(ValueError, "fixture changed before read"):
                runner.load_suite()

    def test_published_report_requires_exact_source_revision(self):
        import io
        from contextlib import redirect_stderr, redirect_stdout
        from unittest.mock import patch

        report = runner.HERE / "scalar-report.json"
        argv = [
            "run.py", "--backend", "forge", "--mode", "stdout-i64",
            "--command", "nonexistent-compiler {source}",
            "--report", str(report)
        ]
        with patch.object(sys, "argv", argv):
            with redirect_stderr(io.StringIO()) as output:
                with self.assertRaises(SystemExit) as thrown:
                    runner.main()
        self.assertEqual(thrown.exception.code, 2)
        self.assertIn("--report requires --revision", output.getvalue())
        self.assertFalse(report.exists())

        # A source revision is a declaration, not a compiler provenance proof.
        # Mocked execution tests reporting only, not guest execution.
        with patch.object(sys, "argv", argv + ["--revision", "a" * 40]):
            with patch.object(runner, "run_case", return_value=(True, "mock-only")):
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(runner.main(), 0)
        data = json.loads(report.read_text())
        self.assertEqual(data["source_revision"], "a" * 40)
        self.assertEqual(data["evidence_level"], "source-executed-scalar")
        self.assertEqual(len(data["results"]), 11)

    def test_manifest_fifo_and_directory_refused_without_reading(self):
        import os
        manifest = runner.HERE / "cases.json"
        manifest.unlink()
        if hasattr(os, "mkfifo"):
            try:
                os.mkfifo(manifest)
            except OSError:
                pass
            else:
                with self.assertRaisesRegex(ValueError, "unique regular file"):
                    runner.load_suite()
                manifest.unlink()
        manifest.mkdir()
        with self.assertRaisesRegex(ValueError, "unique regular file"):
            runner.load_suite()

    def test_manifest_symlink_hardlink_and_sparse_oversize_refused(self):
        import os
        manifest = runner.HERE / "cases.json"
        other = runner.HERE / "manifest-alias.json"
        manifest.rename(other)
        try:
            manifest.symlink_to(other)
        except (OSError, NotImplementedError):
            pass
        else:
            with self.assertRaisesRegex(ValueError, "unique regular file"):
                runner.load_suite()
            manifest.unlink()
        try:
            os.link(other, manifest)
        except OSError:
            pass
        else:
            with self.assertRaisesRegex(ValueError, "unique regular file"):
                runner.load_suite()
            manifest.unlink()
        with manifest.open("wb") as stream:
            stream.truncate(runner.MAX_FIXTURE_BYTES + 1)
        with self.assertRaisesRegex(ValueError, "invalid source length"):
            runner.load_suite()

    def test_backend_negative_requires_case_specific_diagnostic(self):
        source = runner.HERE / "fixtures" / "reject-unknown.ores"
        diagnostics = {
            "forge": {
                "reject.unknown": "oresforge: expected integer at byte 29",
                "reject.division": "oresforge: division requires float result lowering; unsupported in the i64 source subset at byte 30",
                "reject.actor": "oresforge: unexpected token at byte 7",
                "reject.async": "oresforge: unexpected token at byte 4",
                "reject.structural": "oresforge: expected integer at byte 29",
            },
            "net": {
                "reject.unknown": "oresnet: Expected integer at offset 29",
                "reject.division": "oresnet: Division requires float result lowering; unsupported in the i64 source subset",
                "reject.actor": "oresnet: Expected 'fnc' at offset 7",
                "reject.async": "oresnet: Expected 'fnc' at offset 4",
                "reject.structural": "oresnet: Expected integer at offset 29",
            },
        }
        for backend, cases in diagnostics.items():
            for case_id, message in cases.items():
                for ending in ("", "\n", "\r\n"):
                    code = "import sys;sys.stderr.buffer.write(" + repr((message + ending).encode()) + ");sys.exit(1)"
                    with self.subTest(backend=backend, case_id=case_id, ending=repr(ending)):
                        good, _ = runner.run_case(
                            [sys.executable, "-c", code], source, "reject", None,
                            "admission", 3, backend, case_id)
                        self.assertTrue(good, message)
                # An error for the wrong feature or unrelated infrastructure
                # must never satisfy negative source conformance.
                for bad in ("file not found", "unknown compiler option",
                            "usage error", "unexpected token in tool setup"):
                    code = "import sys;sys.stderr.write(" + repr(
                        backend.replace("forge", "oresforge").replace("net", "oresnet") +
                        ": " + bad + "\n") + ");sys.exit(1)"
                    rejected, _ = runner.run_case(
                        [sys.executable, "-c", code], source, "reject", None,
                        "admission", 3, backend, case_id)
                    self.assertFalse(rejected, (backend, case_id, bad))

    def test_scalar_stdout_requires_one_canonical_decimal_line(self):
        source = runner.HERE / "fixtures" / "literal-42.ores"
        outputs = (
            ("42", True), ("42\n", True), ("42\r\n", True),
            (" 42", False), ("\n42\n", False), ("42 \n", False),
            ("42\n\n", False), ("\t42\n", False),
        )
        for output, expected in outputs:
            command = "import sys;sys.stdout.buffer.write(" + repr(output.encode()) + ")"
            with self.subTest(output=repr(output)):
                passed, _ = runner.run_case(
                    [sys.executable, "-c", command], source, "accept", "42",
                    "stdout-i64", 3, "forge", "scalar.literal-42")
                self.assertEqual(passed, expected)

    def test_negative_diagnostic_offset_must_fit_source_bytes(self):
        source = runner.HERE / "fixtures" / "reject-unknown.ores"
        bad = (
            ("forge", "oresforge: expected integer at byte 999999"),
            ("net", "oresnet: Expected integer at offset 999999"),
        )
        for backend, diagnostic in bad:
            command = ("import sys;sys.stderr.write(" + repr(diagnostic + "\n")
                       + ");sys.exit(1)")
            with self.subTest(backend=backend):
                passed, _ = runner.run_case(
                    [sys.executable, "-c", command], source,
                    "reject", None, "admission", 3, backend, "reject.unknown")
                self.assertFalse(passed, "out-of-range parser offset must fail closed")

    def test_no_case_id_cannot_pass_negative_diagnostic(self):
        source = runner.HERE / "fixtures" / "reject-unknown.ores"
        code = "import sys;sys.stderr.write('oresforge: expected integer at byte 29\\\\n');sys.exit(1)"
        passed, _ = runner.run_case(
            [sys.executable, "-c", code], source, "reject", None,
            "admission", 2, "forge")
        self.assertFalse(passed)

    def test_unsupported_backend_diagnostic_evidence_fails_closed(self):
        source = runner.HERE / "fixtures" / "reject-unknown.ores"
        code = "import sys;sys.stderr.write('oresnet: unknown identifier');sys.exit(1)"
        for backend in ("java", "llvm", "wasm", None):
            with self.subTest(backend=backend):
                passed, _ = runner.run_case(
                    [sys.executable, "-c", code], source, "reject", None,
                    "admission", 3, backend)
                self.assertFalse(passed)

    def test_net_admission_requires_typed_ir_success_message(self):
        source = runner.HERE / "fixtures" / "literal-42.ores"
        for message, accepted in (
            ("Oreslang subset syntax and typed OresIR: OK", True),
            ("", False),
            ("ok", False),
            ("Oreslang subset syntax and typed OresIR: INCOMPLETE", False),
        ):
            code = "print(" + repr(message) + ")"
            with self.subTest(message=message):
                passed, _ = runner.run_case(
                    [sys.executable, "-c", code], source, "accept", "42",
                    "admission", 3, "net")
                self.assertEqual(passed, accepted)

    def test_false_success_and_missing_compiler_denied(self):
        source = runner.HERE / "fixtures" / "literal-42.ores"
        missing = runner.run_case([str(runner.HERE / "missing-tool")], source, "accept", "42", "stdout-i64", 2)
        self.assertFalse(missing[0])
        false_success = runner.run_case([sys.executable, "-c", "pass"], source,
                                        "accept", "42", "stdout-i64", 2)
        self.assertFalse(false_success[0])
        wrong_status = runner.run_case([sys.executable, "-c", "import sys;sys.exit(2)"],
                                       source, "reject", None, "admission", 2)
        self.assertFalse(wrong_status[0])
        valid_exit = runner.run_case([sys.executable, "-c", "print(42)"], source,
                                     "accept", "42", "stdout-i64", 2)
        self.assertTrue(valid_exit[0], valid_exit[1])
        crash = runner.run_case([sys.executable, "-c", "import sys;sys.exit(3)"],
                                source, "reject", None, "admission", 2)
        self.assertFalse(crash[0])


    def test_invalid_utf8_rejection_is_not_semantic_success(self):
        source = runner.HERE / "fixtures" / "reject-unknown.ores"
        result = runner.run_case(
            [sys.executable, "-c",
             "import os,sys; os.write(2,bytes([255])); sys.exit(1)"],
            source, "reject", None, "admission", 2)
        self.assertFalse(result[0], "malformed compiler bytes cannot pass rejection")
        self.assertIn("invalid UTF-8", result[1])

    def test_invalid_utf8_guest_output_is_not_scalar_success(self):
        source = runner.HERE / "fixtures" / "literal-42.ores"
        result = runner.run_case(
            [sys.executable, "-c",
             "import os; os.write(1,b'42'+bytes([255]))"],
            source, "accept", "42", "stdout-i64", 2)
        self.assertFalse(result[0])
        self.assertIn("invalid UTF-8", result[1])


    def test_output_limit_enforced_before_process_exits(self):
        import time
        source = runner.HERE / "fixtures" / "literal-42.ores"
        for fd in (1, 2):
            with self.subTest(stream=fd):
                code = ("import os,time; data=b'x'*1048576; "
                        "os.write(" + str(fd) + ",data); time.sleep(10)")
                started = time.monotonic()
                ok, details = runner.run_case(
                    [sys.executable, "-c", code], source, "accept", "42",
                    "stdout-i64", 4, "forge", "scalar.literal-42")
                self.assertFalse(ok)
                self.assertIn("exceeded 64 KiB", details)
                self.assertLess(time.monotonic() - started, 3,
                                "output budget must stop a live noisy compiler")

    def test_subprocess_timeout_is_infrastructure_not_semantic_rejection(self):
        source = runner.HERE / "fixtures" / "reject-unknown.ores"
        code = ("import sys,time; "
                "sys.stderr.write('oresforge: expected integer at byte 29\\n'); "
                "sys.stderr.flush(); time.sleep(10)")
        ok, details = runner.run_case(
            [sys.executable, "-c", code], source, "reject", None,
            "admission", 0.2, "forge", "reject.unknown")
        self.assertFalse(ok)
        self.assertIn("TimeoutExpired", details)

    def test_descendant_inheriting_output_cannot_hold_gate_open(self):
        import os
        import time
        if os.name != "posix":
            self.skipTest("process-group descendant termination is POSIX-only")
        source = runner.HERE / "fixtures" / "literal-42.ores"
        code = ("import subprocess,sys; "
                "subprocess.Popen([sys.executable,'-c',"
                "'import time;time.sleep(10)'],"
                "stdout=sys.stdout,stderr=sys.stderr);"
                "print(42)")
        started = time.monotonic()
        ok, details = runner.run_case(
            [sys.executable, "-c", code], source, "accept", "42",
            "stdout-i64", 0.3, "forge", "scalar.literal-42")
        self.assertFalse(ok)
        self.assertIn("TimeoutExpired", details)
        self.assertLess(time.monotonic() - started, 3)



if __name__ == "__main__":
    unittest.main(verbosity=2)
