import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {compileToProgramIRV2,compileProgramIRV2,compileProgramV2} from '../src/program-v2.mjs';
import {validateProgramIRV2} from '../src/program-ir-v2.mjs';
import {compileFreestandingCore} from '../src/freestanding-core.mjs';

const load = esm => import('data:text/javascript,' + encodeURIComponent(esm));
const compiled = source => load(compileProgramV2(source));

test('canonical ternary: lazy signed-i64 arms, strict bool guard, IR/ESM round trip',async()=>{
  const source='pub fnc choose(bool useFast): int {return useFast ? 42 : 1 % 0;}';
  const ir=compileToProgramIRV2(source);
  assert.equal(ir.functions[0].body.kind,'if');
  assert.equal(ir.functions[0].body.condition.kind,'param');
  assert.deepEqual(validateProgramIRV2(JSON.parse(JSON.stringify(ir))),ir);
  assert.equal(compileProgramIRV2(JSON.parse(JSON.stringify(ir))),compileProgramV2(source));
  const {choose}=await compiled(source);
  assert.equal(choose(true),42n);
  assert.throws(()=>choose(false),/ORES_I64_DIVISION_BY_ZERO/);
  assert.throws(()=>choose(1n),/bool required/);
  assert.throws(()=>choose(0),/bool required/);
});

test('ternary precedence is below compare/arithmetic, and both nesting directions are right associative',async()=>{
  const src=[
    'pub fnc precedence(int a,int b,int limit): int {return a + b > limit ? 11 : 22;}',
    'pub fnc falseNest(bool a,bool b): int {return a ? 1 : b ? 2 : 3;}',
    'pub fnc trueNest(bool a,bool b): int {return a ? b ? 4 : 5 : 6;}',
    'pub fnc booleanNest(bool a,bool b): bool {return a ? !b : b ? false : true;}',
    'pub fnc grouped(bool a): int {return (a ? 1 : 2) + 40;}'
  ].join('\n');
  const mod=await compiled(src);
  assert.equal(mod.precedence(20n,21n,40n),11n);
  assert.equal(mod.precedence(20n,19n,40n),22n);
  assert.equal(mod.falseNest(true,false),1n);
  assert.equal(mod.falseNest(false,true),2n);
  assert.equal(mod.falseNest(false,false),3n);
  assert.equal(mod.trueNest(true,true),4n);
  assert.equal(mod.trueNest(true,false),5n);
  assert.equal(mod.trueNest(false,true),6n);
  assert.equal(mod.booleanNest(true,true),false);
  assert.equal(mod.booleanNest(true,false),true);
  assert.equal(mod.booleanNest(false,false),true);
  assert.equal(mod.grouped(true),41n);
  assert.equal(mod.grouped(false),42n);
});

test('if-then-fi is statement-only, requires explicit returns; legacy if-semicolon-do retained',async()=>{
  const source=[
    'pub fnc magnitude(int x): int {if x >= 0 then return x; else return -x; fi}',
    'pub fnc marker(bool b): int {if b then return 1; fi return 2;}',
    'pub fnc legacy(bool b): int {if b; do return 3; else return 4; fi}'
  ].join('\n');
  const m=await compiled(source);
  assert.equal(m.magnitude(8n),8n);
  assert.equal(m.magnitude(-8n),8n);
  assert.throws(()=>m.magnitude(-(1n<<63n)),/ORES_I64_OVERFLOW/);
  assert.equal(m.marker(true),1n);
  assert.equal(m.marker(false),2n);
  assert.equal(m.legacy(true),3n);
  assert.equal(m.legacy(false),4n);
});

test('unselected ternary arithmetic overflow is not evaluated',async()=>{
  const {safe}=await compiled('pub fnc safe(bool enabled): int {return enabled ? 42 : 9223372036854775807 + 1;}');
  assert.equal(safe(true),42n);
  assert.throws(()=>safe(false),/ORES_I64_OVERFLOW/);
});

test('reject invalid ternary source, non-bool conditions, missing arms and if expressions',()=>{
  const sources=[
    'pub fnc bad(): int {return 1 ? 2 : 3;}',
    'pub fnc bad(bool b): int {return b ? true : 2;}',
    'pub fnc bad(bool b): int {return b ? 1 : false;}',
    'pub fnc bad(bool b): int {return b ? 1;}',
    'pub fnc bad(bool b): int {return b ? : 2;}',
    'pub fnc bad(bool b): int {return b ? 1 : ;}',
    'pub fnc bad(bool b): int {return b ? 1 : 2 ? 3 : 4;}',
    'pub fnc bad(): int {return if true then 1 else 2 fi;}',
    'pub fnc bad(): int {if true then 1; else return 2; fi}',
    'pub fnc bad(): int {if true then return 1; else 2; fi}',
    'pub fnc bad(bool? b): int {return 1;}'
  ];
  for(const source of sources)
    assert.throws(()=>compileProgramV2(source),/error: program v2:|error: program IR:/,source);
});

test('forged IR cannot turn ternary into truthiness or cross-type arms',()=>{
  const original=compileToProgramIRV2('pub fnc selected(bool enabled): int {return enabled ? 1 : 2;}');
  const body=original.functions[0].body;
  const altered=next=>({...original,functions:[{...original.functions[0],body:next}]});
  for(const injected of [
    {...body,condition:{kind:'int',value:'1'}},
    {...body,condition:{kind:'bool',value:1}},
    {...body,yes:{kind:'bool',value:true}},
    {...body,no:{kind:'compare',op:'==',left:{kind:'int',value:'1'},right:{kind:'int',value:'1'}}},
    {...body,extra:'host'}
  ]) assert.throws(()=>compileProgramIRV2(altered(injected)),/error: program IR:/);
});

test('freestanding core supports ternary without adding runtime imports or host effects',async()=>{
  const source='define module core as pub fnc choose(bool fast,int first,int second): int {return fast ? first : second;} end';
  const output=compileFreestandingCore(source);
  assert.doesNotMatch(output,/^\s*import\b/m);
  const {core}=await load(output);
  assert.equal(core.choose(true,42n,0n),42n);
  assert.equal(core.choose(false,42n,0n),0n);
  assert.throws(()=>core.choose(1,42n,0n),/bool required/);
});

test('CLI --program-v2 uses canonical conditionals and writes runnable ESM',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ores-js-conditional-'));
  try{
    const path=join(dir,'sample.ores'),dest=join(dir,'sample.mjs'),cli=resolve('bin/oreslang-jsc.mjs');
    await writeFile(path,'pub fnc choose(bool b): int {if b then return 42; else return b ? 1 : 2; fi}');
    const checked=spawnSync(process.execPath,[cli,'--program-v2','--check',path],{encoding:'utf8'});
    assert.equal(checked.status,0,checked.stderr);
    const built=spawnSync(process.execPath,[cli,'--program-v2',path,'--out='+dest],{encoding:'utf8'});
    assert.equal(built.status,0,built.stderr);
    const m=await import(pathToFileURL(dest).href);
    assert.equal(m.choose(true),42n);
    assert.equal(m.choose(false),2n);
  }finally{await rm(dir,{recursive:true,force:true});}
});
