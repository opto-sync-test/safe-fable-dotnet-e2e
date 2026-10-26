# Native AOT audit and hardening — 2026-10-14 (mailbox disposal and PE validation)

This audit extends draft [PR #1](https://github.com/ores-truffle-oreslang/oreslang-source.net/pull/1).

## Changes committed

- Queued actor payloads are byte-owned copies. `Stop()` and `Restart()` now zeroize **only undelivered** payload arrays under the mailbox lock before dropping queue references. Previously `Queue.Clear()` removed references but left their contents in memory until GC reclaimed them.
- Retained message sender buffers are unchanged; delivered buffers are transferred to callers, so the mailbox cannot promise to erase them after receipt.
- Mailbox constructor rejects an invalid ID, message capacity or byte capacity with the corresponding parameter-specific `ArgumentOutOfRangeException`. Added test coverage.
- Windows PE inspector now rejects a missing DOS MZ header, a DLL/nonexecutable COFF image, an empty/invalid section table, and a missing data-directory entry 14 before interpreting an empty CLR descriptor as proof of an unmanaged binary.
- New `verification/assert-native-pe-regressions.ps1` mutates an actual native application PE to test each fail-closed condition. Windows CI executes it after publishing the native app.

## Security model and remaining gaps

- PE inspection is **not a complete proof** that the executable was built with Microsoft's Native AOT. Pair it with the `PublishAot`-gated toolchain, actual native execution, checks for managed sidecars, and reproducible build artifacts.
- Zeroization reduces retention of undelivered secrets; it does not erase copies held by senders, recipients, OS memory paging, or CLR runtime internals. Managed Native AOT still uses garbage collection and does not provide actor-private heaps.
- Actor reference nonces are local process identity tokens, not authenticated distributed capabilities.
- No source-level code change can unblock an Actions job that fails with **zero executed steps**. Investigate GitHub organization billing, policy and runner allocation separately.

## Verification blocker

The [most recently inspected run](https://github.com/ores-truffle-oreslang/oreslang-source.net/actions/runs/38660558257) failed for Windows and Linux with no executed steps returned. The new tests are committed but **have not been verified as passing**. Keep the PR draft and unmerged until Windows x64 Native AOT publication and execution are confirmed.
