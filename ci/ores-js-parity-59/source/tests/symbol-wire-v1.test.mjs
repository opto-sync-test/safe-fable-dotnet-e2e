import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SymbolWireV1Error,validateSymbolWireV1,symbolWireEqualV1,
  stringifySymbolWireV1,parseSymbolWireJsonV1
} from '../src/symbol-wire-v1.mjs';

test('trusted Symbol wire validates process/stable logical identities',()=>{
  const process=validateSymbolWireV1({'$symbol':'process',name:'ready'});
  const stable=validateSymbolWireV1({
    '$symbol':'stable',name:'550e8400-e29b-41d4-a716-446655440000'
  });
  assert.deepEqual({...process},{'$symbol':'process',name:'ready'});
  assert.deepEqual({...stable},{
    '$symbol':'stable',name:'550e8400-e29b-41d4-a716-446655440000'
  });
  assert.equal(Object.getPrototypeOf(process),null);
  assert.equal(Object.isFrozen(process),true);
  assert.equal(symbolWireEqualV1(process,{'$symbol':'process',name:'ready'}),true);
  assert.equal(symbolWireEqualV1(process,{'$symbol':'process',name:'failed'}),false);
  assert.equal(symbolWireEqualV1(
    {'$symbol':'process',name:'550e8400-e29b-41d4-a716-446655440000'},stable
  ),false);
});

test('wire decoder rejects noncanonical names, hostile records and invalid stable UUIDs',()=>{
  const bad=[
    {'$symbol':'process',name:''},
    {'$symbol':'process',name:'cafe\u0301'},
    {'$symbol':'process',name:'abc\u202edef'},
    {'$symbol':'process',name:'a'.repeat(257)},
    {'$symbol':'stable',name:'hello'},
    {'$symbol':'stable',name:'550E8400-e29b-41d4-a716-446655440000'},
    {'$symbol':'local',name:'ready'},
    {'$symbol':'process',name:'ready',id:1},
    ['process','ready']
  ];
  for(const value of bad)
    assert.throws(()=>validateSymbolWireV1(value),SymbolWireV1Error);

  const exotic=Object.create({x:1});
  exotic.$symbol='process';exotic.name='ready';
  assert.throws(()=>validateSymbolWireV1(exotic),/non-plain/);

  const accessor={'$symbol':'process'};
  Object.defineProperty(accessor,'name',{get(){return 'ready';},enumerable:true});
  assert.throws(()=>validateSymbolWireV1(accessor),/accessor/);

  const hidden={'$symbol':'process'};
  Object.defineProperty(hidden,'name',{value:'ready',enumerable:false});
  assert.throws(()=>validateSymbolWireV1(hidden),/non-enumerable/);

  assert.throws(()=>validateSymbolWireV1(
    {'$symbol':'process',name:'ready'},Object.create({policy:'trusted'})
  ),/non-plain options/);
});

test('untrusted-core policy admits only sealed core PROCESS symbols',()=>{
  for(const name of ['ready','error','Symbol.iterator'])
    assert.equal(validateSymbolWireV1(
      {'$symbol':'process',name},{policy:'untrusted-core'}
    ).name,name);

  for(const value of [
    {'$symbol':'process',name:'userland/secret'},
    {'$symbol':'stable',name:'550e8400-e29b-41d4-a716-446655440000'}
  ]) assert.throws(()=>validateSymbolWireV1(
    value,{policy:'untrusted-core'}
  ),/denied/);
});

test('strict JSON parser rejects duplicate members and non-string/extra/trailing data',()=>{
  const valid=parseSymbolWireJsonV1(
    '{"name":"ready","$symbol":"process"}'
  );
  assert.deepEqual({...valid},{'$symbol':'process',name:'ready'});

  const invalid=[
    '{"$symbol":"process","$symbol":"stable","name":"ready"}',
    '{"$symbol":"process","name":"ready","name":"again"}',
    '{"$symbol":"process","name":"ready","extra":"x"}',
    '{"$symbol":"process","name":7}',
    '{"$symbol":"process","name":"ready"} trailing',
    '[]',
    '{}'
  ];
  for(const text of invalid)
    assert.throws(()=>parseSymbolWireJsonV1(text),SymbolWireV1Error,text);
});

test('stringify/parse text roundtrip is deterministic and canonical',()=>{
  const value={'$symbol':'process',name:'http.ok'};
  const text=stringifySymbolWireV1(value);
  assert.equal(text,'{"$symbol":"process","name":"http.ok"}');
  assert.deepEqual({...parseSymbolWireJsonV1(text)},value);

  const stable={'$symbol':'stable',name:'550e8400-e29b-41d4-a716-446655440000'};
  assert.deepEqual({...parseSymbolWireJsonV1(stringifySymbolWireV1(stable))},stable);
});
