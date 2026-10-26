import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileToProgramIRV2} from '../src/program-v2.mjs';
import {validateProgramIRV2} from '../src/program-ir-v2.mjs';
import {compileFreestandingCore} from '../src/freestanding-core.mjs';

const wrap=body=>'define module core as '+body+' end';
const fixture=()=>readFile(new URL('./fixtures/core-adt-match.ores',import.meta.url),'utf8');

test('exhaustive and mixed ADT patterns have distinct semantic diagnostics',()=>{
  const failures=[
    ['pub fnc f(Option<int> v):int {return match v over {on Some(n) {return n;} };}',/non-exhaustive ADT match/],
    ['pub fnc f(Option<int> v):int {return match v over {on Some(n) {return n;} on Err(e) {return e;} };}',/cannot mix Option and Result variant patterns/],
    ['pub fnc f(Result<int,int> v):int {return match v over {on Ok(n) {return n;} on None {return 0;} };}',/cannot mix Option and Result variant patterns/],
    ['pub fnc f(Option<int> v):bool {return match v over {on Some(n) {return n;} on None {return false;} };}',/ADT int payload capture type mismatch/],
    ['pub fnc f(Option<int> v):int {return match v over {on Some(n) {return n;} on Some(m) {return m;} };}',/duplicate match pattern Some/]
  ];
  for(const [source,diagnostic] of failures)
    assert.throws(()=>compileFreestandingCore(wrap(source)),diagnostic,source);
});

test('forged typed capture and escaped capture fail for different reasons',async()=>{
  const program=compileToProgramIRV2(await fixture());
  const original=program.functions[0];
  const payloadSlot=original.body.arms.find(arm=>arm.tag==='Some').slot;
  const escape={...program,functions:[{...original,body:{kind:'capture',slot:payloadSlot}},...program.functions.slice(1)]};
  assert.throws(()=>validateProgramIRV2(escape),/capture outside its typed payload scope/);
  const typedBody={...original.body,arms:original.body.arms.map(arm=>
    arm.tag==='Some'?{...arm,body:{kind:'capture',slot:payloadSlot}}:
      {...arm,body:{kind:'bool',value:false}})};
  const mistyped={...program,functions:[{...original,returnType:'bool',body:typedBody},...program.functions.slice(1)]};
  assert.throws(()=>validateProgramIRV2(mistyped),/ADT int payload capture type mismatch/);
});

test('valid nested captures and original source ESM remain unchanged',async()=>{
  const generated=compileFreestandingCore(await fixture());
  assert.equal(generated.length,5343);
  assert.match(generated,/case "Some"/);
  assert.match(generated,/case "Err"/);
});
