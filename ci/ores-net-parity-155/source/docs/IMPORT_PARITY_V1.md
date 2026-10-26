# Import parity contract (v1) — shared Oreslang backend target

This is an independently authored specification for Java/Graal, LLVM, .NET,
Forge, and LLVM-derived Wasm builds. **Fail-closed rejection does not
constitute functional parity.** No backend may advertise import parity
until its own parser, resolver and linker/runtime pass the positive tests.

## Required resolution rules

1. `./x` and `../x` resolve relative to the importing source. Bare names
   such as `.hidden/x` or `..backup/x` use configured search roots instead.
2. `+/x` (not `+x` or experimental `@/x`) is confined lexically to the nearest `.ores.pkg.toml` root,
   rejects missing manifests and source files, plus any empty, `.` or `..` path component;
   `+/` and `pkg:` require forward-slash separators and never normalize backslashes into authority.
3. `pkg:alias/x` requires an explicitly declared zed-pkg dependency alias;
   it never initiates package installation. Unknown aliases, invalid
   identifiers, noncanonical segments, and symlinks escaping the selected
   package's physical root must fail closed. Context transitions must validate
   that the imported source's physical identity matches the declared target.
4. Bare search precedence: `[source].roots`, `[source].import_paths`,
   colon-separated `ORES_PATHS`, then host-separator `ORESLANG_PATH`.
   Omitted `roots` defaults to `["."]`; explicit `roots = []` remains empty;
   empty environment entries are ignored.
5. Nearest package manifest outranks a closer legacy compiler manifest.
   Each nested package has independent `+/` and `pkg:` authority.
6. Canonical physical source identity prevents duplicate/self imports and
   rejects the same physical file under conflicting package contexts. Import
   discovery is **not** filesystem confinement; symlink races are separate.
7. Check/build/link/runtime use one source identity graph and deterministic
   traversal-independent resolution. Foreign-language source imports work
   only where a backend has an actual compiler and permission model.
8. Wasm module output requires a verified native compiler and immutable,
   complete source graph; the current scalar-only bridge must reject imports
   even when a stub would otherwise produce a valid scalar Wasm artifact.

9. Entry-only manifest/root overrides (`ORES_MANIFEST_PATH` and
   `ORES_PROJECT_ROOT`, exposed via flags-2-env) must agree when both given,
   reject entry sources outside the selected root, and never affect nested
   package discovery.

## Promotion gates

- **A — safe admission:** all unsupported syntax rejected with no partial
  artifact, including `+/`, `pkg:`, `./`, `../`, `.hidden/x`, bare imports.
- **B — resolver behavior:** positive and negative tests of each namespace,
  precedence, empty roots, nested manifests, symlink identity and aliases.
- **C — actual link/runtime:** independently build and run the same multi-file
  graph with reordered imports, a nested package and a declared dependency.
- **D — provenance:** locked dependencies, exact source identity, tested
  native/AOT builds and actual wasm32 compilation where applicable.

Only executed real-compiler tests count. Synthetic/stub tests, skipped checks,
source-free runner probes and workflows failing before steps are **not** parity
evidence. Status `complete` requires B and C (plus applicable D), never A alone.

## Audited state (October 2026)

| Backend | Import admission | Resolver/linker | Full parity |
| --- | --- | --- | --- |
| Java/Graal | Tests authored in draft PR #1050 | Feature implementation pending executed tests | NOT VERIFIED |
| LLVM | Explicit unsupported-import diagnostic and CTest gates prepared | Import graph not implemented | NO |
| .NET | Explicit unsupported-import diagnostic and parser tests prepared | Import graph not implemented | NO |
| Forge | Explicit unsupported-import diagnostic and parser tests prepared | Import graph not implemented | NO |
| Wasm | Scalar bridge lexical gate and stub-bypass tests prepared | Requires LLVM module graph and wasm32 linker | NO |

Required next work: implement and test B/C in LLVM first, consume verified LLVM
graphs in Wasm, implement corresponding .NET and Forge graphs, then run a shared
per-backend conformance fixture corpus. Do not promote parity on documentation
alone. Java/Graal's source-export security policy must be honored for private
cross-organization CI mirroring.

## Stacked .NET configured-root resolver hardening

The independent host-only `ProjectRootSourceResolver` now respects a
restricted, validated `[project] root = "subdir"` instead of always
assuming `+/` is anchored to the manifest directory. It rejects
duplicate, dotted, absolute, traversal, malformed and missing root
values, and checks for filesystem reparse points at every selected-root
component and every resolved import component. This restricted subset
is not a complete TOML parser or a descriptor-relative filesystem
sandbox; concurrent hostile renames remain outside this contract.

The .NET scalar compiler still **rejects** source imports before CIL
emission and has no source-unit linking. A positive resolver test is
not executable import parity. Tests are authored; they need an
actual .NET runner pass on the exact branch before promotion.
