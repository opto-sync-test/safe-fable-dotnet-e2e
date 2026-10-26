import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileProgramV2,compileToProgramIRV2,compileProgramIRV2
} from '../src/program-v2.mjs';
import {validateProgramIRV2} from '../src/program-ir-v2.mjs';

const load=source=>import('data:text/javascript;charset=utf-8,'+
  encodeURIComponent(compileProgramV2(source)));

test('named and mixed positional/named calls bind by declaration name',async()=>{
  const source=[
    'pub fnc mix(int a,int b,int c):int{return a*100+b*10+c;}',
    'pub fnc named():int{return mix(c:3,a:1,b:2);}',
    'pub fnc mixed():int{return mix(1,c:3,b:2);}'
  ].join('\n');
  const mod=await load(source);
  assert.equal(mod.named(),123n);
  assert.equal(mod.mixed(),123n);
  const ir=compileToProgramIRV2(source);
  assert.equal(ir.functions[1].body.kind,'namedCall');
  assert.deepEqual(ir.functions[1].body.paramOrder,[2,0,1]);
  assert.equal(ir.functions[2].body.kind,'namedCall');
  assert.deepEqual(ir.functions[2].body.paramOrder,[0,2,1]);
  assert.deepEqual(validateProgramIRV2(JSON.parse(JSON.stringify(ir))),ir);
  assert.equal(compileProgramIRV2(JSON.parse(JSON.stringify(ir))),
    compileProgramV2(source));
});

test('qualified typed calls reorder values without losing formal types',async()=>{
  const source=[
    'define module choose as',
    '  pub fnc pick(int yes,bool enabled,int no):int{return enabled ? yes : no;}',
    'end',
    'pub fnc run():int{return choose.pick(no:9,enabled:true,yes:4);}'
  ].join('\n');
  const mod=await load(source);
  assert.equal(mod.run(),4n);
  const call=compileToProgramIRV2(source).functions[1].body;
  assert.equal(call.kind,'namedCall');
  assert.deepEqual(call.paramOrder,[2,1,0]);
});

test('named argument lowering preserves lexical evaluation order before ABI reorder',async()=>{
  const source=[
    'fnc pick(int a,int b):int{return a;}',
    'pub fnc overflowFirst():int{return pick(b:9223372036854775807+1,a:1%0);}',
    'pub fnc zeroFirst():int{return pick(a:1%0,b:9223372036854775807+1);}'
  ].join('\n');
  const mod=await load(source);
  assert.throws(()=>mod.overflowFirst(),/ORES_I64_OVERFLOW/);
  assert.throws(()=>mod.zeroFirst(),/ORES_I64_DIVISION_BY_ZERO/);
});

test('source binding fails closed for malformed labels and unsupported intrinsic names',()=>{
  const invalid=[
    'fnc f(int a,int b):int{return a;} pub fnc x():int{return f(a:1,2);}',
    'fnc f(int a,int b):int{return a;} pub fnc x():int{return f(z:1,b:2);}',
    'fnc f(int a,int b):int{return a;} pub fnc x():int{return f(1,a:2);}',
    'fnc f(int a,int b):int{return a;} pub fnc x():int{return f(a:1,a:2);}',
    'fnc f(int a,int b):int{return a;} pub fnc x():int{return f(a:1);}',
    'fnc f(int a,int b):int{return a;} pub fnc x():int{return f(a:1,b:2,c:3);}',
    'pub fnc x():Option<int>{return Option.some(value:1);}',
    'pub fnc x():Option<int>{return Some(value:1);}'
  ];
  for(const source of invalid)
    assert.throws(()=>compileProgramV2(source),/error: program v2:/,source);
});

test('direct namedCall IR validates a complete permutation and formal-slot typing',()=>{
  const source=[
    'fnc choose(bool enabled,int value):int{return enabled ? value : 0;}',
    'pub fnc run():int{return choose(value:7,enabled:true);}'
  ].join('\n');
  const good=compileToProgramIRV2(source);
  const body=good.functions[1].body;
  assert.equal(body.kind,'namedCall');
  assert.deepEqual(body.paramOrder,[1,0]);
  const mutate=edit=>{
    const ir=JSON.parse(JSON.stringify(good));
    edit(ir.functions[1].body);
    return ir;
  };
  for(const ir of [
    mutate(x=>{x.paramOrder=[0,0];}),
    mutate(x=>{x.paramOrder=[-0,1];}),
    mutate(x=>{x.paramOrder=[0,2];}),
    mutate(x=>{x.paramOrder=[0];}),
    mutate(x=>{x.args.pop();}),
    mutate(x=>{x.target=-0;}),
    mutate(x=>{x.extra=true;}),
    mutate(x=>{x.args[0]={kind:'bool',value:true};})
  ]) assert.throws(()=>compileProgramIRV2(ir),/error: program IR:/);
});

test('ordinary positional calls keep the stable legacy call IR shape',()=>{
  const ir=compileToProgramIRV2(
    'fnc f(int a,int b):int{return a+b;} pub fnc g():int{return f(1,2);}'
  );
  assert.deepEqual(Object.keys(ir.functions[1].body).sort(),['args','kind','target']);
  assert.equal(ir.functions[1].body.kind,'call');
  assert.equal(Object.hasOwn(ir.functions[1].body,'paramOrder'),false);
});
