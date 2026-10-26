# Exact-head GitHub Actions evidence gate (.NET)

Status: **validation tooling only, not a CI execution receipt**.

GitHub Actions runs on the private .NET repository have repeatedly returned
`failure` with **zero job steps**. These are *not* build/test failures with
compiler diagnostics and are not successful execution evidence. The current
tools cannot read organization billing/runner allocation settings. Inspect the
GitHub Actions UI and have an authorized administrator check spending policies,
runners and billing before requesting additional expensive runs.

This evidence parser is read-only and uses Node.js built-in modules. It never
connects to GitHub or acquires credentials. The JSON inputs must be fetched
from the originating repo, at the reviewed run ID/attempt, independently of
the source branch being reviewed. Fake fixture data must never be used as
release evidence.

## Capture and validate a real run

```bash
REPO=ores-truffle-oreslang/oreslang-source.net
HEAD=<independently-reviewed-40-character-PR-head>
RUN_ID=<actual-Windows-Native-AOT-run-id>
ATTEMPT=1
gh api "repos/$REPO/actions/runs/$RUN_ID" > run.json
gh api "repos/$REPO/actions/runs/$RUN_ID/attempts/$ATTEMPT/jobs?per_page=100" > jobs.json
node verification/ci-evidence-gate.mjs --repo "$REPO" --head "$HEAD" \
  --run-id "$RUN_ID" --attempt "$ATTEMPT" \
  --workflow "Windows Native AOT" --run run.json --jobs jobs.json
```

The gate fails if any of the following is true: different run/repo/SHA/
attempt/workflow, non-successful run, incomplete jobs list, missing required
job, zero executed job steps, missing any explicitly named hosted workflow
step, malformed/duplicate step names or numbers, or failed/skipped required
job steps. Every job must identify the selected run, attempt and source head. The disabled opt-in
`self-hosted-windows-static-facts` job may be skipped; successful mandatory
hosted Windows and Linux jobs remain required; an enabled self-hosted job must
execute all its explicitly named steps successfully. Checkout assertions and the
Windows receipt emission/upload steps must also succeed. It does **not** independently replay
a binary, validate the runner's logs or prove a compiler's memory safety.

Repeat independently for `Integration declaration integrity` using
`--workflow "Integration declaration integrity"` and its own run ID.

Self-test without GitHub/credentials:

```bash
node --test verification/ci-evidence-gate.test.mjs
```

Pass requires actual Windows x64 Native AOT workflow execution at the reviewed
head, Linux diagnostic execution, the declaration-integrity workflow (with
the explicit declaration-only designation), independent review and any required
project-specific cross-backend contract gates. Linux-only results do not
certify Windows. A failed/zero-step run cannot be substituted with synthetic
or another organization's pass. Do not export private source to other
organizations without an approved security review.
