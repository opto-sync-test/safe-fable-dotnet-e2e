import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileProgramV2,compileToProgramIRV2,compileProgramIRV2} from '../src/program-v2.mjs';
import {compileFreestandingCore} from '../src/freestanding-core.mjs';
import {compileLinkedFreestandingCore} from '../src/freestanding-core-link.mjs';
import {validateProgramIRV2} from '../src/program-ir-v2.mjs';

const get=path=>readFile(new URL(path,import.meta.url),'utf8');
const core=()=>get('./fixtures/core-adt-match.ores');
const app=()=>get('./fixtures/core-adt-match-linked-app.ores');
const load=esm=>import('data:text/javascript,'+encodeURIComponent(esm));
const src=fn=>'define module core as '+fn+' end';

test('exhaustive matches bind signed-i64 payloads in pure core ESM',async()=>{
  const m=(await load(compileFreestandingCore(await core()))).core;
  for(const n of [-9n,-1n,0n,1n,42n]){
    const option=m.into_option(n),result=m.into_result(n);
    assert.equal(m.add_one(option),n>0n?n+1n:0n);
    assert.equal(m.is_some(option),n>0n);
    assert.equal(m.extract_result(result),n<0n?-n:n);
    assert.equal(m.nested(option),n>0n?n+n:-1n);
  }
  assert.throws(()=>m.add_one(m.into_result(9n)),/tagged value/);
  assert.throws(()=>m.extract_result(m.into_option(9n)),/tagged value/);
  assert.throws(()=>m.add_one({kind:'Some',value:4n}),/tagged value/);
  assert.throws(()=>m.add_one(Object.freeze({kind:'None',value:null})),/tagged value/);
});

test('linked application uses nested ADT matching without OS/browser imports',async()=>{
  const esm=compileLinkedFreestandingCore({coreSource:await core(),appSource:await app()});
  assert.doesNotMatch(esm,/^\s*import\b/m);
  const m=await load(esm);
  for(let n=-256n;n<=256n;n++){
    assert.equal(m.sample(n),n>0n?n+1n:0n);
    assert.equal(m.result(n),n<0n?-n:n);
    assert.equal(m.nested(n),n>0n?n+n:-1n);
  }
});

test('canonical value-match fixture syntax is recognized within pure core scope',async()=>{
  const source=src('pub fnc compute(Option<int> value): int {return match value over {on Some(n) {return n + 1;} on None {return 0;} };}');
  const m=(await load(compileFreestandingCore(source))).core;
  const adt=(await load(compileFreestandingCore(await core()))).core;
  assert.equal(m.compute(adt.into_option(41n)),42n);
  assert.equal(m.compute(adt.into_option(-1n)),0n);
});

test('ADT variants must be exhaustive and cannot shadow captured or parameter names',()=>{
  for(const invalid of [
    'pub fnc f(Option<int> v):int {return match v over {on Some(n) {return n;} };}',
    'pub fnc f(Result<int,int> v):int {return match v over {on Ok(n) {return n;} };}',
    'pub fnc f(Option<int> v):int {return match v over {on None {return 0;} };}',
    'pub fnc f(Option<int> v):int {return match v over {on None {return 0;} on None {return 1;} };}',
    'pub fnc f(Option<int> v):int {return match v over {on Some(n) {return n;} on Some(m) {return m;} };}',
    'pub fnc f(Option<int> v):int {return match v over {on Some(n) {return n;} on Err(e) {return e;} };}',
    'pub fnc f(Result<int,int> v):int {return match v over {on Ok(n) {return n;} on None {return 0;} };}',
    'pub fnc f(Option<int> v):int {return match v over {on Some(v) {return v;} on None {return 0;} };}',
    'pub fnc f(Option<int> v):int {return match v over {on Some(n) {return match Option.some(n) over {on Some(n) {return n;} on None {return 0;} };} on None {return 0;} };}',
    'pub fnc f(Option<int> v):int {return match v over {on Some() {return 1;} on None {return 0;} };}',
    'pub fnc f(Option<int> v):int {return match v over {on Some(n,e) {return n;} on None {return 0;} };}',
    'pub fnc f(Option<int> v):int {return match v over {on None(n) {return n;} on Some(x) {return x;} };}',
    'pub fnc f(Option<int> v):int {return match v over {on Some(n) {return n;} else {return 0;} };}',
    'pub fnc f(int v):int {return match v over {on Some(n) {return n;} on None {return 0;} };}',
    'pub fnc f(Result<int,int> v):int {return match v over {on Some(n) {return n;} on None {return 0;} };}',
    'pub fnc f(Option<int> v):bool {return match v over {on Some(n) {return n;} on None {return false;} };}',
    'pub fnc f(Option<int> v):int {return match v over {on Some(n) {return true;} on None {return 0;} };}'
  ])assert.throws(()=>compileFreestandingCore(src(invalid)),/error:/,invalid);
});

test('unscoped or forged capture slots reject in externally supplied IR',async()=>{
  const ir=compileToProgramIRV2(await core());
  assert.deepEqual(validateProgramIRV2(JSON.parse(JSON.stringify(ir))),ir);
  const first=ir.functions[0],base=first.body;
  const withBody=body=>({...ir,functions:[{...first,body},...ir.functions.slice(1)]});
  const mutate=(index,changes)=>({...base,arms:base.arms.map((x,i)=>i===index?{...x,...changes}:x)});
  const forged=[
    {kind:'capture',slot:base.arms[0].slot},
    mutate(0,{slot:null}),
    mutate(0,{slot:-1}),
    mutate(0,{slot:-0}),
    mutate(0,{slot:30000}),
    mutate(0,{slot:Infinity}),
    mutate(0,{body:{kind:'capture',slot:-0}}),
    mutate(0,{body:{kind:'capture',slot:99999}}),
    mutate(1,{body:{kind:'capture',slot:base.arms[0].slot}}),
    mutate(1,{slot:0}),
    {...base,adt:'result<int,int>'},
    {...base,arms:[base.arms[0]]},
    {...base,arms:[base.arms[0],base.arms[0]]},
    {...base,arms:[{...base.arms[0],tag:'Err'},base.arms[1]]},
    {...base,subject:{kind:'int',value:'1'}},
    {...base,arms:[{...base.arms[0],extra:true},base.arms[1]]},
    {...base,arms:[{...base.arms[0],body:{kind:'bool',value:true}},base.arms[1]]}
  ];
  for(const body of forged)
    assert.throws(()=>compileProgramIRV2(withBody(body)),/error: program IR:/);
});

test('legacy integer match, bool and immutable tagged ADT remain unaffected',async()=>{
  const srcMatch='pub fnc choose(int n):int {return match n over on 1 -> {10;} else -> {20;} end;}';
  const x=await load(compileProgramV2(srcMatch));
  assert.equal(x.choose(1n),10n);
  assert.equal(x.choose(2n),20n);
  const previous=await get('./fixtures/freestanding-core-java.ores');
  assert.equal(compileProgramV2(previous).length,1662);
  const v=(await load(compileFreestandingCore(await core()))).core.into_option(1n);
  assert.equal(Object.isFrozen(v),true);
  assert.equal(Object.getPrototypeOf(v),null);
});

test('pinned shared Option/Result i64 conformance vectors execute in JS ESM',async()=>{
  // Pinned copies from oreslang-platform-conformance PR #153:
  // source Git blob 229b02ed7378ed0219fb161dbf98d602a91ec07a
  // vectors Git blob 1d945d07bbcb07b642a1f3effd995aa938fbe3c1
  const source=await get('./fixtures/conformance-option-result-i64.ores');
  const contract=JSON.parse(await get('./fixtures/conformance-option-result-i64.json'));
  assert.equal(contract.schema,'oreslang.portable-option-result-i64.v0');
  assert.deepEqual(contract.capabilityRequirements,[]);
  const module=(await load(compileFreestandingCore(source))).core;
  for(const v of contract.testVectors){
    const value=module[v.function](...v.args.map(BigInt));
    const actual=typeof value==='bigint'?{int:String(value)}:
      {variant:value.kind,...(value.kind==='None'?{}:{value:String(value.value)})};
    assert.deepEqual(actual,v.expected,v.id);
  }
  assert.equal(contract.testVectors.length,10);
});

test('ADT match arms can return typed Option values without losing tags',async()=>{
  const typed=src(`pub fnc preserve(Option<int> value):Option<int> {
    return match value over {
      on Some(n) {return Some(n);}
      on None {return None;}
    };
  }
  pub fnc checked(Result<int,int> value):Option<int> {
    return match value over {
      on Ok(n) {return Some(n);}
      on Err(e) {return None;}
    };
  }`);
  const adt=(await load(compileFreestandingCore(await core()))).core;
  const m=(await load(compileFreestandingCore(typed))).core;
  assert.equal(m.preserve(adt.into_option(5n)).value,5n);
  assert.equal(m.preserve(adt.into_option(-5n)).kind,'None');
  assert.equal(m.checked(adt.into_result(9n)).value,9n);
  assert.equal(m.checked(adt.into_result(-9n)).kind,'None');
});
