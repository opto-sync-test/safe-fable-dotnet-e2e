# Cross-backend scalar source gate v1

The reference source semantics come from Oreslang Java. Identical bytes in this directory
must be mirrored wherever this suite is used. The first two positive programs match the
existing Java/LLVM v1 admission fixtures.

The 11-case revision has six positive signed-i64 programs and five negative
bootstrap-admission programs. The sixth positive fixture,
`fixtures/i64-max-minus-one.ores`, pins Java/LLVM reference arithmetic
`9223372036854775807 - 1 = 9223372036854775806` without overflowing
any i64 intermediate. This is a fixture contract, not proof that every
backend has executed or compiled it.

Run the Python 3 standard-library-only gate with an explicit compiler command; never
execute this manifest as a shell script or count negative compiler crashes as rejection.

- **stdout-i64**: Forge source-interpreter execution, exact decimal result.
- **admission**: .NET source + verified IR acceptance only. It is NOT guest execution.
- Unsupported actor, async and structural constructs must return exactly exit 1, empty
  stdout and a compiler-owned diagnostic: `oresnet:` for .NET, `oresforge:` for Forge.
  A generic error, wrong backend prefix, signal, timeout, exit 2, missing tool or
  empty diagnostic fails the gate. Negative claims by other backends fail closed
  until their frontend diagnostic format is independently reviewed.
- .NET admission additionally requires the exact typed-IR success message;
  arbitrary exit-zero processes do not prove source or type admission.
- Both `cases.json` and fixture sources are bounded regular-file reads; special
  files and source/manifest substitution are rejected before acceptance.
- Every report includes a SHA-256 over the manifest and byte-exact fixtures. Exact
  candidate commit provenance is provided by CI; standalone runs without a report may omit --revision.
  For a written --report, --revision is mandatory; the value is a declaration, not proof of the compiler's provenance.
- Scalar execution output must be exactly the canonical signed-i64 decimal
  token, optionally followed by one LF or CRLF; leading/trailing spaces and
  additional lines are rejected.
- If a negative frontend diagnostic declares a source byte offset, that offset
  must be within the verified source fixture (including its EOF boundary).
  Out-of-range offsets cannot be counted as valid compiler refusal.
- Real native/AOT execution must be verified by independent release workflows.

`python3 contracts/scalar/v1/run.py --backend forge --mode stdout-i64 --command './build/oresforge run {source}'`
`python3 contracts/scalar/v1/run.py --backend net --mode admission --command './artifacts/compiler/win-x64/oresnet.exe check {source}'`
