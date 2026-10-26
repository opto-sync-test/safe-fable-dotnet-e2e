import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { verifyEvidence } from "./ci-evidence-gate.mjs";

const repo = "ores-truffle-oreslang/oreslang-source.net";
const sha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const e = {repo,head:sha,runId:12345,attempt:1,workflow:"Windows Native AOT"};
const run = {id:12345,run_attempt:1,name:"Windows Native AOT",head_sha:sha,
  status:"completed",conclusion:"success",event:"pull_request",
  repository:{full_name:repo}};
const jobs = {total_count:2,jobs:[
  {name:"windows-x64",run_id:12345,run_attempt:1,head_sha:sha,
    status:"completed",conclusion:"success",steps:[
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
      "Upload native executable",
    ].map((name,i)=>({name,number:i+1,status:"completed",conclusion:"success"}))},
  {name:"linux-aot-diagnostic",run_id:12345,run_attempt:1,head_sha:sha,
    status:"completed",conclusion:"success",steps:[
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
      "Execute Linux Native AOT CFG branch and simultaneous-assignment fixture",
    ].map((name,i)=>({name,number:i+1,status:"completed",conclusion:"success"}))},
]};
const copy=x=>JSON.parse(JSON.stringify(x));
const check=(r,j)=>verifyEvidence(r,j,e);
test("valid exact-head, same-run, full-step evidence",()=>assert.deepEqual(check(run,jobs),[]));
test("zero steps are never proof",()=>{const j=copy(jobs);j.jobs[0].steps=[];assert.match(check(run,j).join(" "),/zero executed/);});
test("different repository rejected",()=>assert.match(check({...run,repository:{full_name:"other/repo"}},jobs).join(" "),/repository/));
test("wrong SHA rejected",()=>assert.match(check({...run,head_sha:"0".repeat(40)},jobs).join(" "),/head/));
test("wrong attempt rejected",()=>assert.match(check({...run,run_attempt:2},jobs).join(" "),/attempt/));
test("wrong run rejected",()=>assert.match(check({...run,id:44},jobs).join(" "),/run ID/));
test("failed step rejected",()=>{const j=copy(jobs);j.jobs[0].steps[1].conclusion="failure";assert.notEqual(check(run,j).length,0);});
test("missing mandatory job rejected",()=>{const j=copy(jobs);j.jobs.pop();j.total_count=1;assert.match(check(run,j).join(" "),/missing/);});
test("paginated/truncated jobs rejected",()=>{const j=copy(jobs);j.total_count=3;assert.match(check(run,j).join(" "),/incomplete/);});
test("pending workflow rejected",()=>assert.match(check({...run,status:"in_progress",conclusion:null},jobs).join(" "),/not passed/));
test("missing native execution step rejected",()=>{const j=copy(jobs);j.jobs[0].steps = j.jobs[0].steps.filter(s=>s.name!=="Execute real Windows Native AOT binary");assert.match(check(run,j).join(" "),/missing successful step/);});
test("ambiguous duplicate job rejected",()=>{const j=copy(jobs);j.jobs.push(copy(j.jobs[0]));j.total_count=3;assert.match(check(run,j).join(" "),/duplicated/);});
test("declaration-only evidence must not masquerade as AOT",()=>{
  const x=copy(run);x.name="Integration declaration integrity";
  const p={...e,workflow:"Integration declaration integrity"};
  assert.notEqual(verifyEvidence(x,jobs,p).length,0);
});

test("checkout assertion is required",()=>{const j=copy(jobs);j.jobs[0].steps.shift();assert.match(check(run,j).join(" "),/missing successful step/);});
test("receipt upload is required",()=>{const j=copy(jobs);j.jobs[0].steps.pop();assert.match(check(run,j).join(" "),/missing successful step/);});
test("disabled self-hosted fallback is permitted only alongside mandatory hosted jobs",()=>{
  const j=copy(jobs);j.jobs.push({name:"self-hosted-windows-static-facts",run_id:12345,run_attempt:1,head_sha:sha,status:"completed",conclusion:"skipped"});j.total_count++;
  assert.deepEqual(check(run,j),[]);
  j.jobs.shift();j.total_count--;assert.match(check(run,j).join(" "),/missing/);
});
test("failed opt-in self-hosted fallback remains rejected",()=>{
  const j=copy(jobs);j.jobs.push({name:"self-hosted-windows-static-facts",run_id:12345,run_attempt:1,head_sha:sha,status:"completed",conclusion:"failure"});j.total_count++;
  assert.match(check(run,j).join(" "),/not successful/);
});
test("Rust declaration tooling evidence is admitted and missing Rust tests rejected",()=>{
  const p={...e,workflow:"Integration declaration integrity"};const r={...run,name:p.workflow};
  const j={total_count:1,jobs:[{name:"declaration-integrity",run_id:e.runId,run_attempt:1,head_sha:sha,status:"completed",conclusion:"success",steps:[
    "Assert exact originating-source checkout","Test Rust repository policy tooling",
    "Verify declaration-only manifest (not a runtime parity claim)"
  ].map((name,i)=>({name,number:i+1,status:"completed",conclusion:"success"}))}]};
  assert.deepEqual(verifyEvidence(r,j,p),[]);j.jobs[0].steps.splice(1,1);
  assert.match(verifyEvidence(r,j,p).join(" "),/missing successful step/);
});

for (const name of ["Publish native compiler and native application",
  "Verify signed-i64 static facts on the published Native AOT compiler",
  "Reject corrupted Native AOT PE headers",
  "Compile verified CFG into a real Windows Native AOT executable"]) {
  test(`omitted substantive Windows step denied: ${name}`, () => {
    const j=copy(jobs);j.jobs[0].steps=j.jobs[0].steps.filter(s=>s.name!==name);
    assert.match(check(run,j).join(" "), /missing successful step/);
  });
}
test("omitted substantive Linux CFG step denied",()=>{
  const j=copy(jobs);j.jobs[1].steps=j.jobs[1].steps.filter(s=>s.name!==
    "Execute Linux Native AOT CFG branch and simultaneous-assignment fixture");
  assert.match(check(run,j).join(" "),/missing successful step/);
});
test("duplicate step names are ambiguous even with different numbers",()=>{
  const j=copy(jobs);j.jobs[0].steps.push({...j.jobs[0].steps[0],number:100});
  assert.match(check(run,j).join(" "),/duplicate step name/);
});
test("invalid and duplicate step numbers are denied",()=>{
  for (const number of [0,-1,1,1.5]) {
    const j=copy(jobs);j.jobs[0].steps[1].number=number;
    assert.match(check(run,j).join(" "),/malformed step|duplicate step number/);
  }
});
test("malformed job rows cannot hide inside a complete job count",()=>{
  const j=copy(jobs);j.jobs.push(null);j.total_count++;
  assert.match(check(run,j).join(" "),/malformed job/);
});
test("optional skipped job still requires same run, attempt and source identity",()=>{
  for (const override of [{run_id:1},{run_attempt:2},{head_sha:"0".repeat(40)}]) {
    const j=copy(jobs);j.jobs.push({name:"self-hosted-windows-static-facts",
      run_id:12345,run_attempt:1,head_sha:sha,status:"completed",conclusion:"skipped",...override});
    j.total_count++;assert.notEqual(check(run,j).length,0);
  }
});
test("missing job attempt cannot stand for independently selected attempt",()=>{
  const j=copy(jobs);delete j.jobs[0].run_attempt;
  assert.match(check(run,j).join(" "),/different attempt/);
});

test("hosted evidence fixtures cover every explicitly named source workflow step",()=>{
  const source=readFileSync(new URL("../.github/workflows/windows-native-aot.yml",import.meta.url),"utf8");
  for(const job of jobs.jobs) {
    const block=source.split(`  ${job.name}:\n`)[1]?.split(/^  [a-z][a-z0-9-]*:/m)[0];
    assert.ok(block,`source workflow job ${job.name} exists`);
    const names=[...block.matchAll(/^      - name: (.+)$/gm)].map(m=>m[1]);
    assert.deepEqual(job.steps.map(s=>s.name),names);
    for(const name of names) {
      const j=copy(jobs);const target=j.jobs.find(item=>item.name===job.name);
      target.steps=target.steps.filter(step=>step.name!==name);
      assert.match(check(run,j).join(" "),/missing successful step/,`${job.name}: ${name}`);
    }
  }
});
