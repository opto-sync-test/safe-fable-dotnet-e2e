import test from 'node:test';
import assert from 'node:assert/strict';
import {copyOwnedValue,copyOwnedValueWithBytes} from '../src/worker-actor-copy.mjs';
const MiB=1024*1024;
const beforeClone=(act,match)=>{
  const old=globalThis.structuredClone;
  let calls=0;
  globalThis.structuredClone=(v)=>{calls++;return old(v);};
  try{assert.throws(act,match);assert.equal(calls,0);}finally{globalThis.structuredClone=old;}
};
test('allowed primitive scalars, boxed scalars and Dates',()=>{
  for(const v of [null,undefined,true,false,13,-42,3.14,1n,'hello',new Date(1000),new Date(NaN),new Number(3),new Boolean(false),Object(42n)]){
    const result=copyOwnedValueWithBytes(v);
    assert.ok(result.bytes>=0);
  }
  assert.equal(copyOwnedValue(new Date(1234)).getTime(),1234);
});
test('cycles, ordinary records, map/set/typed backing preserve ownership',()=>{
  const x={n:1};x.self=x;
  const view=new Uint8Array([5,6]);const val={x,map:new Map([['x',view]]),set:new Set([x]),view};
  const s=copyOwnedValue(val);
  assert.notEqual(s,val);assert.equal(s.x.self,s.x);
  assert.equal(s.map.get('x').buffer,s.view.buffer);
  view[0]=99;assert.equal(s.view[0],5);
});
test('non-plain class, host objects and unsupported cloneables fail before clone',()=>{
  const values=[new Error('hidden'),new TypeError('hidden'),new URL('https://example.org'),
    new WeakMap(),new WeakSet(),new Promise(()=>{}),new (class C{constructor(){this.a=1}})(),
    Object.create({inherited:1}),Symbol('nope'),()=>3];
  for(const v of values)beforeClone(()=>copyOwnedValue(v),/unsupported actor wire/);
});
test('sparse array with huge length cannot trigger clone allocation',()=>{
  beforeClone(()=>copyOwnedValue(new Array(2**30)),/complexity exceeded/);
});
test('Date/boxed types with changed prototypes are checked by intrinsic slots',()=>{
  for(const x of [new Date(1000),new Number(12),new Boolean(true),Object(12n),Object('abc')]){
    Object.setPrototypeOf(x,Object.prototype);
    const receipt=copyOwnedValueWithBytes(x);
    assert.ok(receipt.bytes>0);
  }
});
test('prototype-modified shared memory is rejected before clone',()=>{
  if(typeof SharedArrayBuffer!=='function')return;
  const s=new SharedArrayBuffer(8);Object.setPrototypeOf(s,Object.prototype);
  beforeClone(()=>copyOwnedValue(s),/shared-memory/);
});
test('oversized RegExp, bigint, buffers, and spoofed iterators are rejected before clone',()=>{
  const r=new RegExp('x'.repeat(4*MiB+1));
  beforeClone(()=>copyOwnedValue(r),/byte budget exceeded/);
  beforeClone(()=>copyOwnedValue(BigInt('0x'+'f'.repeat(16*MiB+1))),/byte budget exceeded/);
  const buffer=new ArrayBuffer(9*MiB);Object.setPrototypeOf(buffer,Object.prototype);
  beforeClone(()=>copyOwnedValue(buffer),/byte budget exceeded/);
  const map=new Map([['x',new ArrayBuffer(9*MiB)]]);
  map[Symbol.iterator]=()=>[][Symbol.iterator]();
  beforeClone(()=>copyOwnedValue(map),/byte budget exceeded/);
});
test('oversized boxed strings are rejected before clone',()=>{
  const s=Object('x'.repeat(4*MiB+1));Object.setPrototypeOf(s,Object.prototype);
  beforeClone(()=>copyOwnedValue(s),/byte budget exceeded/);
});
test('accessors are not invoked by the preflight',()=>{
  const v={};let calls=0;Object.defineProperty(v,'boom',{get(){calls++;return 'x';}});
  beforeClone(()=>copyOwnedValue(v),/accessors forbidden/);assert.equal(calls,0);
});
