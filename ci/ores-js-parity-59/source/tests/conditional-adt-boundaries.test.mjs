import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileProgramV2,compileToProgramIRV2,compileProgramIRV2
} from '../src/program-v2.mjs';

const evaluate=source=>import('data:text/javascript,'+encodeURIComponent(compileProgramV2(source)));

test('typed Option ternary delays unselected checked-i64 overflow',async()=>{
  const mod=await evaluate('pub fnc f(bool b): Option<int> {return b ? Some(7) : Some(9223372036854775807 + 1);}');
  assert.equal(mod.f(true).value,7n);
  assert.throws(()=>mod.f(false),/ORES_I64_OVERFLOW/);
});

test('nested Option and bool conditionals respect arm selection and scope',async()=>{
  const mod=await evaluate('pub fnc nested(bool b,bool c): int {return match b ? Some(c ? 7 : 3) : None over on Some(n) {n;} on None {2;} end;}');
  assert.equal(mod.nested(true,true),7n);
  assert.equal(mod.nested(true,false),3n);
  assert.equal(mod.nested(false,false),2n);
});

test('Result constructor qualifiers compose with matched payload return type',async()=>{
  const mod=await evaluate('pub fnc f(bool b): int {return match b ? Result.ok(2) : Result.err(3) over on Ok(v) {v;} on Err(e) {e;} end;}');
  assert.equal(mod.f(true),2n);
  assert.equal(mod.f(false),3n);
});

test('program source rejects NUL and malformed UTF-16 before comment stripping',()=>{
  const valid='pub fnc f(): int {return 1;}';
  for(const source of [
    valid+' // '+String.fromCharCode(0),
    valid+' /* '+String.fromCharCode(0)+' */',
    valid+' // '+String.fromCharCode(0xd800),
    valid+' /* '+String.fromCharCode(0xdc00)+' */',
    String.fromCharCode(0xdc00)+valid
  ]) assert.throws(()=>compileProgramV2(source),/error: program v2:/);
  assert.doesNotThrow(()=>compileProgramV2(valid+' // '+String.fromCodePoint(0x1f642)));
});

const invalidSources=[
  ['missing None', 'pub fnc f(): int {return match Some(7) over on Some(n) {n;} end;}'],
  ['duplicate Some', 'pub fnc f(): int {return match Some(7) over on Some(n) {n;} on Some(m) {m;} end;}'],
  ['mixed ADT variants', 'pub fnc f(): int {return match Some(7) over on Some(n) {n;} on Err(e) {e;} end;}'],
  ['capture escapes arm', 'pub fnc f(): int {return match Some(7) over on Some(n) {n;} on None {n;} end;}'],
  ['capture shadows parameter', 'pub fnc f(int x): int {return match Some(7) over on Some(x) {x;} on None {0;} end;}'],
  ['different ADT typed ternary arms', 'pub fnc f(bool b): Option<int> {return b ? Some(7) : Err(1);}'],
  ['non-boolean typed guard', 'pub fnc f(Option<int> x): int {return x ? 1 : 2;}'],
  ['ADT wildcard', 'pub fnc f(): int {return match Some(7) over on Some(n) {n;} on _ {0;} end;}'],
  ['None with payload', 'pub fnc f(): int {return match Some(7) over on Some(n) {n;} on None(n) {0;} end;}'],
  ['unknown None constructor', 'pub fnc f(): Option<int> {return None(7);}'],
  ['binding used after match', 'pub fnc f(): int {return (match Some(7) over on Some(n) {n;} on None {0;} end) + n;}']
];
for(const [name,source] of invalidSources)
  test('source admission fails closed: '+name,()=>{
    assert.throws(()=>compileProgramV2(source),/error: program v2:|error: program IR:/);
  });

const good=compileToProgramIRV2(
  'pub fnc f(): int {return match Some(7) over on Some(n) {n;} on None {0;} end;}');
const attack=(edit)=>{
  const ir=JSON.parse(JSON.stringify(good));
  edit(ir.functions[0].body);
  return ir;
};
const invalidIR=[
  ['unbound capture slot', attack(adt=>{adt.arms[0].body.slot=5;})],
  ['duplicate Some arms', attack(adt=>{adt.arms[1].tag='Some';adt.arms[1].slot=2;})],
  ['incorrect subject type', attack(adt=>{adt.subject={kind:'int',value:'2'};})],
  ['None payload binding', attack(adt=>{adt.arms[1].slot=6;})],
  ['Option and Result tag mix', attack(adt=>{adt.arms[1].tag='Err';adt.arms[1].slot=6;})]
];
for(const [name,ir] of invalidIR)
  test('IR admission fails closed: '+name,()=>{
    assert.throws(()=>compileProgramIRV2(ir),/error: program IR:/);
  });
