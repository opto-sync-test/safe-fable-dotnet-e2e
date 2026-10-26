import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProgramV2,compileToProgramIRV2,compileProgramIRV2} from '../src/program-v2.mjs';
import {validateProgramIRV2} from '../src/program-ir-v2.mjs';

const evaluate=source=>import('data:text/javascript,'+encodeURIComponent(compileProgramV2(source)));

test('canonical ternary selects typed Option/Result branches lazily',async()=>{
  const source=[
    'pub fnc wrap(bool enabled,int x): Option<int> {return enabled ? Some(x) : None;}',
    'pub fnc run(bool enabled,int x): int {return match wrap(enabled,x) over on Some(value) {value;} on None {7;} end;}',
    'pub fnc answer(bool enabled,int x): Result<int,int> {return enabled ? Ok(x) : Err(-9);}',
    'pub fnc recover(bool enabled,int x): int {return match answer(enabled,x) over on Ok(value) {value;} on Err(error) {error;} end;}'
  ].join('\n');
  const mod=await evaluate(source);
  assert.equal(mod.run(true,42n),42n);
  assert.equal(mod.run(false,42n),7n);
  assert.equal(mod.recover(true,42n),42n);
  assert.equal(mod.recover(false,42n),-9n);
  assert.throws(()=>mod.run(1n,42n),/bool required/);
  assert.throws(()=>mod.recover(1,42n),/bool required/);
  const ir=compileToProgramIRV2(source);
  assert.deepEqual(validateProgramIRV2(JSON.parse(JSON.stringify(ir))),ir);
  assert.equal(compileProgramIRV2(JSON.parse(JSON.stringify(ir))),compileProgramV2(source));
});

test('canonical statement-only if composes with exhaustive ADT expression matching',async()=>{
  const src=[
    'pub fnc classify(bool enabled,int x): int {',
    '  if enabled then',
    '    return match Some(x) over on Some(n) {n;} on None {0;} end;',
    '  else',
    '    return 0;',
    '  fi',
    '}'
  ].join('\n');
  const mod=await evaluate(src);
  assert.equal(mod.classify(true,42n),42n);
  assert.equal(mod.classify(false,42n),0n);
  assert.throws(()=>compileProgramV2(
    'pub fnc invalid(bool b): int {return if b then 1 else 2 fi;}'),
    /error: program v2:/);
});

test('nested ternary preserves right associativity and selected-arm-only overflow',async()=>{
  const m=await evaluate('pub fnc select(bool first,bool second): int {return first ? 42 : second ? 7 : 9223372036854775807 + 1;}');
  assert.equal(m.select(true,false),42n);
  assert.equal(m.select(false,true),7n);
  assert.throws(()=>m.select(false,false),/ORES_I64_OVERFLOW/);
});

test('IR admission forbids unscoped captures and cross-type ternary arms',()=>{
  const base=compileToProgramIRV2('pub fnc sample(bool enabled): int {return enabled ? 42 : 0;}');
  const mutate=body=>({...base,functions:[{...base.functions[0],body}]});
  const body=base.functions[0].body;
  for(const attack of [
    {...body,condition:{kind:'int',value:'1'}},
    {...body,yes:{kind:'bool',value:true}},
    {...body,no:{kind:'capture',slot:0}},
    {...body,extra:'host'}
  ]) assert.throws(()=>compileProgramIRV2(mutate(attack)),/error: program IR:/);
});
