// Read-only GitHub Actions evidence validator. No network calls or tokens.
// The run and jobs JSON must be acquired independently from the originating
// GitHub repository API; fixtures alone never establish execution.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const requiredByWorkflow = {
  "Windows Native AOT": {
    "windows-x64": [
      "Assert exact originating-source checkout (Windows)",
      "Verify pinned Sendable Serializable DATA CONTROL contract",
      "Validate PowerShell verification syntax",
      "Show Windows .NET toolchain",
      "Refuse managed or framework-dependent release settings",
      "Verify compiler and runtime source",
      "Verify shared advisory static facts from .NET compiler and typed structured parser",
      "Reject oversized and invalid UTF-8 compiler input",
      "Publish native compiler and native application",
      "Exercise the released Native AOT compiler CLI",
      "Verify signed-i64 static facts on the published Native AOT compiler",
      "Adversarial scalar runner self-tests (Windows)",
      "Shared scalar source admission on the released Native AOT compiler",
      "Execute real Windows Native AOT binary",
      "Confirm strict Native AOT PE and reject managed assembly",
      "Reject corrupted Native AOT PE headers",
      "Execute Native AOT checked-arithmetic error cases",
      "Reject managed sidecar next to an otherwise native executable",
      "Compile verified CFG into a real Windows Native AOT executable",
      "Execute shared five-backend native.add source in real Windows Native AOT",
      "Execute shared native.precedence in Windows Native AOT",
      "Emit exact-head Windows Native AOT run receipt",
      "Upload exact-head Windows Native AOT receipt",
      "Upload native executable"
    ],
    "linux-aot-diagnostic": [
      "Assert exact originating-source checkout (Linux)",
      "Install Linux Native AOT prerequisites",
      "Show Linux .NET toolchain",
      "Verify fail-closed AOT release settings",
      "Run frontend, metadata and mailbox regressions",
      "Validate real .NET static-facts JSON on Linux managed compiler",
      "Adversarial scalar runner self-tests (Linux)",
      "Shared scalar source admission diagnostic (managed compiler only)",
      "Emit generated CIL using the compiler",
      "Native AOT publish generated application (diagnostic only)",
      "Execute Linux Native AOT generated application",
      "Execute Linux Native AOT CFG branch and simultaneous-assignment fixture"
    ],
    "self-hosted-windows-static-facts": [
      "Checkout trusted same-repository pull request",
      "Confirm checked-out exact PR head",
      "Check installed Windows Native AOT toolchain",
      "Run .NET compiler and runtime regression harness",
      "Verify real scalar and experimental structured static facts",
      "Publish and verify released Native AOT compiler",
      "Execute real published Windows Native AOT application",
      "Match Native AOT static facts against managed facts at exact head"
    ]
  },
  "Integration declaration integrity": {
    "declaration-integrity": [
      "Assert exact originating-source checkout",
      "Test Rust repository policy tooling",
      "Verify declaration-only manifest (not a runtime parity claim)"
    ]
  }
};
export function verifyEvidence(run, response, expected) {
  const errors = [];
  const fail = (condition, explanation) => { if (!condition) errors.push(explanation); };
  const hex = /^[a-f0-9]{40}$/i;
  fail(hex.test(expected.head), "expected head must be a full 40-digit SHA");
  fail(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repo), "invalid expected repository");
  fail(Number.isSafeInteger(expected.runId) && expected.runId > 0, "expected run ID required");
  fail(Number.isSafeInteger(expected.attempt) && expected.attempt > 0, "expected attempt required");
  fail(Object.hasOwn(requiredByWorkflow,expected.workflow),"unrecognized workflow");
  if (run === null || typeof run !== "object" || Array.isArray(run)) {
    errors.push("run JSON must be an object");
    return errors;
  }
  fail(run.id === expected.runId, "run ID does not match independently selected run");
  fail(run.run_attempt === expected.attempt, "run attempt does not match");
  fail(run.repository?.full_name === expected.repo, "wrong run repository");
  fail(run.head_sha === expected.head, "run head is not the reviewed commit");
  fail(run.name === expected.workflow, "wrong workflow");
  fail(run.status === "completed" && run.conclusion === "success", "workflow has not passed");
  fail(["pull_request","workflow_dispatch","push"].includes(run.event), "unsupported workflow event");
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    errors.push("jobs JSON must be an object");
    return errors;
  }
  const jobs = response.jobs;
  if (!Array.isArray(jobs)) {
    errors.push("jobs array absent");
    return errors;
  }
  fail(Number.isInteger(response.total_count) && response.total_count === jobs.length && jobs.length > 0,
    "jobs list incomplete, empty or paginated");
  const requirements = requiredByWorkflow[expected.workflow] || {};
  const disabledOptional = job => expected.workflow === "Windows Native AOT" &&
    job.name === "self-hosted-windows-static-facts" &&
    job.status === "completed" && job.conclusion === "skipped";
  const jobNames = new Set();
  for (const job of jobs) {
    if (!job || typeof job !== "object" || Array.isArray(job) ||
        typeof job.name !== "string" || job.name.trim() === "") {
      errors.push("jobs list has malformed job");
      continue;
    }
    fail(!jobNames.has(job.name), `duplicate job name: ${job.name}`);
    jobNames.add(job.name);
    fail(job.run_id === expected.runId, `job ${job.name} belongs to different run`);
    fail(job.run_attempt === expected.attempt, `job ${job.name} belongs to different attempt`);
    fail(job.head_sha === expected.head, `job ${job.name} has different source head`);
  }
  for (const [name, stepsRequired] of Object.entries(requirements)) {
    const matches=jobs.filter(job=>job && job.name===name);
    if (name === "self-hosted-windows-static-facts" && matches.length === 0) continue;
    fail(matches.length===1, `required job ${name} missing or duplicated`);
    if (matches.length!==1) continue;
    const job=matches[0];
    if (disabledOptional(job)) continue;
    fail(job.status==="completed" && job.conclusion==="success", `job ${name} not successful`);
    const steps=job.steps;
    if (!Array.isArray(steps) || steps.length===0) {
      errors.push(`job ${name} has zero executed steps`);
      continue;
    }
    const numbers=new Set();
    const names=new Set();
    for (const step of steps) {
      if (!step || typeof step !== "object" || Array.isArray(step) ||
          !Number.isSafeInteger(step.number) || step.number <= 0 ||
          typeof step.name !== "string" || step.name.trim() === "") {
        errors.push(`job ${name} has malformed step`);
        continue;
      }
      fail(!numbers.has(step.number), `job ${name} has duplicate step number`);
      numbers.add(step.number);
      fail(!names.has(step.name), `job ${name} has duplicate step name`);
      names.add(step.name);
      fail(step.status==="completed" && step.conclusion==="success",
        `job ${name} step ${step.name} was not successful`);
    }
    for (const stepName of stepsRequired) {
      fail(steps.some(s=>s && s.name===stepName && s.status==="completed" && s.conclusion==="success"),
        `job ${name} missing successful step: ${stepName}`);
    }
  }
  for (const job of jobs) {
    if (job && !Object.hasOwn(requirements,job.name)) {
      // This source-local fallback is opt-in; its disabled state must not
      // invalidate successful mandatory hosted Windows and Linux evidence.
      if (disabledOptional(job)) continue;
      fail(job.status==="completed" && job.conclusion==="success",
        `extra job ${job.name} is not successful`);
    }
  }
  return errors;
}

function commandLine(args) {
  const options={};
  for (let i=0;i<args.length;i+=2) {
    if (!args[i]?.startsWith("--") || i+1>=args.length || args[i+1].startsWith("--"))
      throw new Error("expected --key value pairs");
    const key=args[i].slice(2);
    if (Object.hasOwn(options,key)) throw new Error("duplicate argument: "+key);
    options[key]=args[i+1];
  }
  for (const key of ["repo","head","run-id","attempt","workflow","run","jobs"])
    if (!options[key]) throw new Error("missing --"+key);
  if (!/^[0-9]+$/.test(options["run-id"]) || !/^[0-9]+$/.test(options.attempt))
    throw new Error("positive decimal run ID and attempt required");
  return {options,expected:{repo:options.repo,head:options.head,
    runId:Number(options["run-id"]),attempt:Number(options.attempt),
    workflow:options.workflow}};
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const {options,expected}=commandLine(process.argv.slice(2));
    const run=JSON.parse(readFileSync(options.run,"utf8"));
    const jobs=JSON.parse(readFileSync(options.jobs,"utf8"));
    const errors=verifyEvidence(run,jobs,expected);
    if (errors.length!==0) {
      for (const error of errors) console.error("DENIED: "+error);
      process.exitCode=1;
    } else {
      console.log("EVIDENCE_ACCEPTED repo="+expected.repo+
        " head="+expected.head+" run="+expected.runId+
        " attempt="+expected.attempt+" workflow="+expected.workflow);
    }
  } catch (err) {
    console.error("DENIED: "+String(err?.message??err));
    process.exitCode=1;
  }
}
