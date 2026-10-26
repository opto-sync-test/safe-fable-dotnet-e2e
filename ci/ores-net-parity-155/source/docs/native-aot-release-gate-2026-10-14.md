# Windows Native AOT release gate — implementation update (2026-10-14)

This PR is still a **draft**. Source changes do not establish successful execution.

## Concrete fixes

- Fixed `ActorMailbox.Restart()` returning an `ActorRef` without its new per-mailbox nonce. That was a compile-time error after the capability-token hardening.
- Added a regression case rejecting the default/uninitialized actor reference after restart.
- Made `ManagedPEBuilder` use a content-derived `BlobContentId` instead of its default time-based image ID. This complements the deterministic MVID and the existing byte-for-byte reproducibility test.
- The Windows publish script now removes previous compiler, generated-CIL and application binaries before publishing. Stale successful outputs cannot satisfy checks after a failed run.
- Windows CI now runs an **actual Native AOT arithmetic-error matrix**: `overflow.ores`, `division-by-zero.ores`, and `division-overflow.ores` (minimum i64 / -1). Each example gets a separately regenerated host publish, PE validation, and must exit 70 with the correct diagnostic.
- The native compiler and successful `hello.ores` application must still publish and execute before the error matrix runs.

## Execution evidence required

1. Windows GitHub runner starts a real job step; inspect Actions settings, budget and organization runner policy if it fails without steps.
2. Unit tests pass on the actual CIL emitter, including 2,048-operand expressions, reproducible binaries, stack limits and mailbox concurrency.
3. Native Windows x64 `oresnet.exe` builds and passes malformed-input tests.
4. Native Windows x64 `oreslang-app.exe` executes the happy path and all arithmetic error variants.
5. Both binaries satisfy native PE checks, and no generated DLL or managed runtime configuration leaks into the final application.
6. Review all AOT analysis warnings, signing/release plans, and source conformance gaps before merging.

**Blocker:** Hosted Windows and Linux Actions jobs have repeatedly reported failure with zero retrieved steps. Code has been committed and tests scheduled, but no runnable Windows AOT evidence is available as of this update. Do not merge PR #1.
