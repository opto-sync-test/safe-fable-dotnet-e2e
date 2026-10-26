import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileProgramV2,compileToProgramIRV2,compileProgramIRV2
} from '../src/program-v2.mjs';

const load=(source,suffix='')=>import('data:text/javascript;charset=utf-8,'+
  encodeURIComponent(compileProgramV2(source))+'#'+suffix);

test('Symbol equality is logical by kind and canonical name, never pointer identity',async()=>{
  const source=[
    'pub fnc ready():Symbol{return #ready;}',
    'pub fnc failed():Symbol{return #failed;}',
    'pub fnc eq(Symbol a,Symbol b):bool{return a==b;}',
    'pub fnc ne(Symbol a,Symbol b):bool{return a!=b;}',
    'pub fnc same():bool{return ready()==#ready;}'
  ].join('\n');
  const mod=await load(source,'logical');
  const a=mod.ready(),b=mod.ready();
  assert.notStrictEqual(a,b);
  assert.equal(mod.eq(a,b),true);
  assert.equal(mod.ne(a,b),false);
  assert.equal(mod.eq(a,mod.failed()),false);
  assert.equal(mod.ne(a,mod.failed()),true);
  assert.equal(mod.same(),true);
  const ir=compileToProgramIRV2(source);
  assert.equal(ir.functions[2].body.kind,'symbolCompare');
  assert.equal(ir.functions[3].body.kind,'symbolCompare');
  assert.equal(ir.functions[4].body.kind,'symbolCompare');
});

test('future Symbol declaration manifest spelling is reserved fail-closed',()=>{
  for(const source of [
    'define symbol #ready;',
    'define pub symbol #ready;'
  ]) assert.throws(()=>compileProgramV2(source),
    /Symbol declaration\/export manifest not implemented/,source);
});

test('Symbol comparison rejects mixed domains and non-equality operators',()=>{
  for(const source of [
    'pub fnc bad(Symbol s):bool{return s==1;}',
    'pub fnc bad(Symbol s):bool{return 1==s;}',
    'pub fnc bad(Symbol s):bool{return s< #ready;}',
    'pub fnc bad():bool{return #ready>true;}'
  ]) assert.throws(()=>compileProgramV2(source),/error: program v2:/,source);
});

test('direct IR cannot forge Symbol comparison typing or operators',()=>{
  const good=compileToProgramIRV2(
    'pub fnc eq(Symbol a,Symbol b):bool{return a==b;}'
  );
  assert.equal(good.functions[0].body.kind,'symbolCompare');
  const mutate=edit=>{
    const ir=JSON.parse(JSON.stringify(good));
    edit(ir.functions[0].body);
    return ir;
  };
  for(const ir of [
    mutate(x=>{x.op='<';}),
    mutate(x=>{x.kind='compare';}),
    mutate(x=>{x.left={kind:'int',value:'1'};}),
    mutate(x=>{x.right={kind:'bool',value:true};}),
    mutate(x=>{x.extra=true;})
  ]) assert.throws(()=>compileProgramIRV2(ir),/error: program IR:/);
});

test('artifact wire bridge rebrands canonical Symbols across compiled modules',async()=>{
  const source=[
    'pub fnc ready():Symbol{return #ready;}',
    'pub fnc uuidProcess():Symbol{return #"550e8400-e29b-41d4-a716-446655440000";}',
    'pub fnc eq(Symbol a,Symbol b):bool{return a==b;}'
  ].join('\n');
  const first=await load(source,'wire-a');
  const second=await load(source,'wire-b');
  const bridgeA=first['@oreslang/symbol-wire-v1'];
  const bridgeB=second['@oreslang/symbol-wire-v1'];
  assert.ok(bridgeA&&bridgeB);
  const foreign=first.ready();
  assert.throws(()=>second.eq(foreign,second.ready()),/Oreslang Symbol required/);
  const wire=bridgeA.encode(foreign);
  assert.deepEqual({...wire},{'$symbol':'process',name:'ready'});
  const imported=bridgeB.decode(wire);
  assert.equal(second.eq(imported,second.ready()),true);

  const stableWire=Object.freeze(Object.assign(Object.create(null),{
    '$symbol':'stable',name:'550e8400-e29b-41d4-a716-446655440000'
  }));
  const stableA=bridgeA.decode(stableWire);
  const stableB=bridgeA.decode(stableWire);
  assert.equal(first.eq(stableA,stableB),true);
  assert.equal(first.eq(stableA,first.uuidProcess()),false);
  assert.deepEqual({...bridgeA.encode(stableA)},{
    '$symbol':'stable',name:'550e8400-e29b-41d4-a716-446655440000'
  });
});

test('generated wire bridge enforces exact shape, canonical names and core policy',async()=>{
  const mod=await load(
    'pub fnc echo(Symbol s):Symbol{return s;}',
    'wire-policy'
  );
  const bridge=mod['@oreslang/symbol-wire-v1'];
  for(const name of ['ready','error','Symbol.iterator']){
    assert.equal(bridge.decode({'$symbol':'process',name},'untrusted-core').name,name);
  }
  for(const value of [
    {'$symbol':'process',name:'hidden'},
    {'$symbol':'stable',name:'550e8400-e29b-41d4-a716-446655440000'}
  ]) assert.throws(()=>bridge.decode(value,'untrusted-core'),/denied/);

  for(const value of [
    {'$symbol':'local',name:'ready'},
    {'$symbol':'process',name:'cafe\u0301'},
    {'$symbol':'stable',name:'550E8400-e29b-41d4-a716-446655440000'},
    {'$symbol':'process',name:'ready',extra:true},
    Object.freeze(['process','ready'])
  ]) assert.throws(()=>bridge.decode(value),/Oreslang Symbol wire/);

  const accessor={'$symbol':'process'};
  Object.defineProperty(accessor,'name',{get(){return 'ready';},enumerable:true});
  assert.throws(()=>bridge.decode(accessor),/accessor/);
  const hidden={'$symbol':'process'};
  Object.defineProperty(hidden,'name',{value:'ready',enumerable:false});
  assert.throws(()=>bridge.decode(hidden),/non-enumerable/);
});
