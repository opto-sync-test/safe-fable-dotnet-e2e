import test from 'node:test';
import assert from 'node:assert/strict';
import {copyOwnedValue,copyOwnedValueWithBytes} from '../src/worker-actor-copy.mjs';

function rejectedBeforeClone(value, pattern) {
  const original=globalThis.structuredClone;
  let calls=0;
  globalThis.structuredClone=x=>{calls++;return original(x);};
  try {
    assert.throws(()=>copyOwnedValue(value),pattern);
    assert.equal(calls,0,'untrusted payload must never reach structuredClone');
  } finally {
    globalThis.structuredClone=original;
  }
}
test('native Errors cannot be disguised as plain records with Object.setPrototypeOf',()=>{
  for(const error of [
    new Error('sensitive'),
    new TypeError('sensitive'),
    new RangeError('sensitive'),
    new AggregateError([new Error('cause')],'sensitive'),
  ]) {
    Object.setPrototypeOf(error,Object.prototype);
    rejectedBeforeClone(error,/unsupported actor wire object type/);
  }
});
test('Error native brand cannot be hidden by a forged Symbol.toStringTag',()=>{
  const error=new Error('sensitive');
  Object.setPrototypeOf(error,Object.prototype);
  // Remove V8's lazy Error.stack accessor so the forged symbol is tested directly.
  delete error.stack;
  Object.defineProperty(error,Symbol.toStringTag,{value:'Object',configurable:true});
  rejectedBeforeClone(error,/unsupported actor wire symbol key/);
});
test('plain records cannot smuggle clone-ignored symbol-key metadata',()=>{
  rejectedBeforeClone({[Symbol.for('meta')]:new ArrayBuffer(10)},/unsupported actor wire symbol key/);
  rejectedBeforeClone(Object.assign(Object.create(null),{[Symbol.for('meta')]:1}),
    /unsupported actor wire symbol key/);
});
test('unsupported exotic host objects fail closed even after prototype changes',()=>{
  for(const value of [new URL('https://example.org'),new WeakMap(),Promise.resolve(1)]) {
    Object.setPrototypeOf(value,Object.prototype);
    // Generic JavaScript has no portable brand reader for every host exotic.
    // For these unsupported types structuredClone itself rejects: this is
    // fail-closed behavior, not a guarantee of pre-clone rejection.
    assert.throws(()=>copyOwnedValue(value),/unsupported actor wire|DataCloneError|Cannot clone/);
  }
});
test('ordinary and null-prototype records still clone, including cycles',()=>{
  const normal={key:'ok',nested:[1,2,3]};
  const record=Object.create(null);
  record.child=normal;record.self=record;
  const result=copyOwnedValue(record);
  assert.notEqual(result,record);
  assert.equal(result.self,result);
  assert.deepEqual(result.child,normal);
  assert.ok(copyOwnedValueWithBytes(result).bytes>0);
});
test('known cloneable internal slots still work under prototype changes',()=>{
  const examples=[new Date(1234),/abc/i,new Map([[1,2]]),new Set([1,2]),new ArrayBuffer(10),Object('hi')];
  for(const value of examples) {
    Object.setPrototypeOf(value,Object.prototype);
    const result=copyOwnedValue(value);
    assert.ok(result!==undefined);
  }
});

test('own Symbol.toStringTag getter is never executed during native brand validation',()=>{
  let calls=0;
  const value={payload:'ordinary'};
  Object.defineProperty(value,Symbol.toStringTag,{
    get(){calls++;return 'Object';},configurable:true
  });
  rejectedBeforeClone(value,/unsupported actor wire symbol key/);
  assert.equal(calls,0);
});

test('inherited Symbol.toStringTag cannot disguise native Error without invoking getter',()=>{
  const disguised=new Error('hidden Error data');
  Object.setPrototypeOf(disguised,Object.prototype);
  // Remove the lazy stack own-property: prior validator then cloned before reject.
  delete disguised.stack;
  const previous=Object.getOwnPropertyDescriptor(Object.prototype,Symbol.toStringTag);
  let getterCalls=0,clones=0;
  const original=globalThis.structuredClone;
  try {
    Object.defineProperty(Object.prototype,Symbol.toStringTag,{
      configurable:true,
      get(){getterCalls++;return 'Object';}
    });
    globalThis.structuredClone=(value)=>{clones++;return original(value);};
    assert.throws(
      ()=>copyOwnedValue(disguised),
      /unsupported actor wire inherited symbol tag/
    );
    assert.equal(getterCalls,0);
    assert.equal(clones,0);
    assert.throws(
      ()=>copyOwnedValue({ok:1}),
      /unsupported actor wire inherited symbol tag/
    );
    assert.equal(getterCalls,0);
    assert.equal(clones,0);
    const nullRecord=Object.create(null);nullRecord.ok=1;
    // structuredClone normalizes null-prototype records into ordinary ones.
    // Post-clone validation must also fail closed while global tags are polluted.
    assert.throws(
      ()=>copyOwnedValue(nullRecord),
      /unsupported actor wire inherited symbol tag/
    );
    assert.equal(getterCalls,0);
    assert.equal(clones,1);
  } finally {
    globalThis.structuredClone=original;
    if(previous)Object.defineProperty(Object.prototype,Symbol.toStringTag,previous);
    else delete Object.prototype[Symbol.toStringTag];
  }
});
