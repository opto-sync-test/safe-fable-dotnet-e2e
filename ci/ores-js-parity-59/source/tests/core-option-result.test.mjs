import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileFreestandingCore} from '../src/freestanding-core.mjs';
import {compileLinkedFreestandingCore} from '../src/freestanding-core-link.mjs';
import {compileToProgramIRV2,compileProgramV2,compileProgramIRV2} from '../src/program-v2.mjs';
import {validateProgramIRV2} from '../src/program-ir-v2.mjs';

const source=()=>readFile(new URL('./fixtures/core-option-result.ores',import.meta.url),'utf8');
const app=()=>readFile(new URL('./fixtures/core-option-result-linked-app.ores',import.meta.url),'utf8');
const old=()=>readFile(new URL('./fixtures/freestanding-core-java.ores',import.meta.url),'utf8');
const load=async esm=>import('data:text/javascript,'+encodeURIComponent(esm));

test('immutable tagged Option/Result values and exact strict ABI',async()=>{
  const {core}=await load(compileFreestandingCore(await source()));
  const some=core.positive(9n),none=core.positive(-1n);
  const ok=core.negative(3n),err=core.negative(-3n);
  for(const x of [some,none,ok,err]){
    assert.equal(Object.getPrototypeOf(x),null);
    assert.equal(Object.isFrozen(x),true);
    assert.deepEqual(Reflect.ownKeys(x).sort(),['kind','value']);
  }
  assert.equal(some.kind,'Some');assert.equal(some.value,9n);
  assert.equal(none.kind,'None');assert.equal(none.value,null);
  assert.equal(ok.kind,'Ok');assert.equal(ok.value,3n);
  assert.equal(err.kind,'Err');assert.equal(err.value,-3n);
  assert.equal(core.contains(some),true);
  assert.equal(core.contains(none),false);
  assert.equal(core.fallback(none,12n),12n);
  assert.equal(core.fallback(some,12n),9n);
  assert.equal(core.succeeded(ok),true);
  assert.equal(core.succeeded(err),false);
  assert.equal(core.value_or(err,12n),12n);
  assert.equal(core.value_or(ok,12n),3n);
  assert.equal(core.error_or(err,12n),-3n);
  assert.equal(core.error_or(ok,12n),12n);
  assert.equal(core.internal_option(8n),8n);
  assert.equal(core.internal_result(8n),8n);
  assert.throws(()=>core.fallback(ok,1n),/tagged value type/);
  assert.throws(()=>core.value_or(some,1n),/tagged value type/);
  assert.throws(()=>core.fallback(none,1),/BigInt/);
  assert.throws(()=>core.negative(1n<<63n),/OVERFLOW/);
  assert.throws(()=>core.positive(1),/BigInt/);
  assert.throws(()=>core.positive(),/arity/);
});

test('host values cannot smuggle malformed tagged values into a core function',async()=>{
  const {core}=await load(compileFreestandingCore(await source()));
  const rec=(kind,value)=>{
    const v=Object.create(null);
    Object.defineProperties(v,{kind:{value:kind,enumerable:true},value:{value,enumerable:true}});
    return Object.freeze(v);
  };
  for(const bad of [
    {kind:'Some',value:1n}, // regular JS object prototype
    Object.freeze({kind:'Some',value:1n}),
    rec('Some',1),rec('None',42n),rec('Err',1n),
    rec('Some',1n<<63n),rec('Some',null),rec('Prototype',1n),
    Object.freeze(Object.assign(Object.create(null),{kind:'Some',value:1n,extra:1})),
    Object.freeze(Object.defineProperties(Object.create(null),{
      kind:{value:'Some',enumerable:true},
      value:{get(){throw Error('must never read accessor');},enumerable:true}
    }))
  ]){
    assert.throws(()=>core.fallback(bad,7n),/TypeError|RangeError/);
  }
  const mutable=Object.assign(Object.create(null),{kind:'Some',value:1n});
  assert.throws(()=>core.fallback(mutable,2n),/tagged value/);
  // These are pure *data* values rather than capabilities. A correctly
  // shaped frozen host value may cross the ABI, after full validation.
  assert.equal(core.fallback(rec('Some',5n),3n),5n);
  assert.equal(core.fallback(rec('None',null),3n),3n);
});

test('linked application can pass Option/Result values between pure functions',async()=>{
  const code=compileLinkedFreestandingCore({coreSource:await source(),appSource:await app()});
  assert.doesNotMatch(code,/^\s*import\b/m);
  const mod=await load(code);
  for(let n=-256n;n<=256n;n++){
    assert.equal(mod.positive_or_zero(n),n>0n?n:0n);
    assert.equal(mod.negative_is_error(n),n<0n);
    assert.equal(mod.checked_value(n),n<0n?42n:n);
  }
  assert.equal(mod.core.positive(5n).kind,'Some');
  assert.equal(mod.core.negative(-1n).kind,'Err');
});

test('ADTs cannot be interpreted as bool, int, unrelated type, or hosted effects',()=>{
  for(const source of [
    'define module core pub fnc fail(): int {return Option.none();} end',
    'define module core pub fnc fail(): bool {return Option.some(1);} end',
    'define module core pub fnc fail(): Option<int> {return Result.ok(1);} end',
    'define module core pub fnc fail(): Result<int,int> {return Option.some(1);} end',
    'define module core pub fnc fail(int x): Option<bool> {return Option.some(x);} end',
    'define module core pub fnc fail(): Result<int,bool> {return Result.ok(1);} end',
    'define module core pub fnc fail(): Result<int,int> {return Result.unknown(1);} end',
    'define module core pub fnc fail(): Option<int> {return Option.some(true);} end',
    'define module core pub fnc fail(): Option<int> {return Some(true);} end',
    'define module core pub fnc fail(): Result<int,int> {return Err(true);} end',
    'define module core pub fnc fail(): bool {return None;} end',
    'define module core pub fnc fail(): int {return Result.unwrap_or(Option.some(1),0);} end',
    'define module core pub fnc fail(): int {return Option.unwrap_or(Result.ok(1),0);} end',
    'define module Option pub fnc some(int x): int {return x;} end',
    'define module Result pub fnc ok(int x): int {return x;} end',
    'define module core pub fnc fail(): int {return process.exit(0);} end'
  ])assert.throws(()=>compileFreestandingCore(source),/error:/);
});

test('external IR cannot forge ADT intrinsic operation or argument types',async()=>{
  const good=compileToProgramIRV2(await source());
  assert.deepEqual(validateProgramIRV2(JSON.parse(JSON.stringify(good))),good);
  const index=good.functions.findIndex(fn=>fn.name==='positive');
  const mutate=body=>({...good,functions:good.functions.map((fn,i)=>i===index?{...fn,body}:fn)});
  const lit={kind:'int',value:'1'},some={kind:'intrinsic',name:'Option.some',args:[lit]};
  for(const bad of [
    {kind:'intrinsic',name:'Option.some',args:[]},
    {kind:'intrinsic',name:'Option.none',args:[lit]},
    {kind:'intrinsic',name:'Option.some',args:[{kind:'bool',value:true}]},
    {kind:'intrinsic',name:'Option.fake',args:[lit]},
    {kind:'intrinsic',name:'Result.ok',args:[lit]},
    {kind:'intrinsic',name:'__proto__',args:[lit]},
    {kind:'intrinsic',name:'Option.some',args:[lit],extra:true},
    {kind:'intrinsic',name:'Option.unwrap_or',args:[some,lit]},
    {kind:'intrinsic',name:'Option.some',args:[{kind:'intrinsic',name:'Option.none',args:[]}]}
  ])assert.throws(()=>compileProgramIRV2(mutate(bad)),/error: program IR:/);
});

test('old integer-only IR and emitted ESM remain stable',async()=>{
  const src=await old(),ir=compileToProgramIRV2(src);
  assert.equal(compileProgramV2(src).length,1662);
  assert.equal(ir.functions.length,3);
  for(const fn of ir.functions){
    assert.equal(Object.hasOwn(fn,'returnType'),false);
    assert.equal(Object.hasOwn(fn,'paramTypes'),false);
  }
  const {core}=await load(compileFreestandingCore(src));
  assert.equal(core.clamp_int(99n,0n,10n),10n);
});

test('intrinsics inside int-only signatures still emit required helpers',async()=>{
  const src='define module core pub fnc value(int x): int {return Option.unwrap_or(Option.some(x),0);} end';
  const {core}=await load(compileFreestandingCore(src));
  assert.equal(core.value(42n),42n);
  const src2='define module core pub fnc value(int x): int {return Result.unwrap_or(Result.err(x),99);} end';
  const {core:res}=await load(compileFreestandingCore(src2));
  assert.equal(res.value(-4n),99n);
});
