# Core logging / OTel boundary — .NET / Native AOT

**Audit date:** 2026-10-16. **Status:** documented target only; implementation parity **not established**.

Shared design: [core logging and userland OTel contract](https://github.com/ores-truffle-oreslang/oreslang-common-source/blob/audit/core-logging-separation-2026-10-16/docs/CORE_LOGGING_AND_OTEL.md).

## Verified repository status

This repo is a one-function signed-int64 compiler bootstrap with a bounded mailbox prototype. There is no Oreslang userland module import implementation or evidence of Java core diagnostic flag parity.

## Required backend behavior

- Core/internal standard-library diagnostics are controlled by host CLI/configuration, disabled by default, and independent of explicit userland `oreslang-otel` imports.
- Future canonical core flags: `--core-log-level=off|error|warn|info|debug|trace` and `--no-core-log`. These are **not currently declared implemented for this backend**; do not advertise them as usable.
- Never perform guest message formatting, string interpolation, allocating event construction, filesystem/network export, or telemetry callbacks in a scheduler/actor/borrow checker critical path. Disabled paths must not sample the clock or evaluate an expensive payload.
- Keep guest stdout and functional errors unaffected by diagnostic settings. No guest payload, headers, credentials or arbitrary dynamic fields in core events.
- Version schemas; record numeric IDs and timestamps in bounded primitive buffers; export to host stderr only off the hot path.

## Implementation and test gates

Use a Native AOT-compatible, statically linked bounded recorder (preallocated primitive storage, Interlocked slot reservation, release/acquire publication). Parse/validate CLI switches before executing a guest. Export to host stderr after execution and never add Reflection.Emit or runtime loading. The OTel user library must remain unsupported until real Oreslang imports are implemented. Add Native AOT and test-mode evidence; do not rely on managed-test-only results for release claims.

Do not mark parity green until a compiled/linked artifact has passed negative admission tests, CLI configuration-precedence tests, saturation and concurrent publication tests, and disabled/enabled performance tests. Record the exact source tree and CI run.
