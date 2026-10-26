import test from 'node:test';
import assert from 'node:assert/strict';
import {copyOwnedValue,copyOwnedValueWithBytes} from '../src/worker-actor-copy.mjs';
test('overridden collection iterator is ignored as in existing Worker contract',()=>{
 const map=new Map([[1,{answer:42}]]);
 map[Symbol.iterator]=()=>[][Symbol.iterator]();
 assert.equal(copyOwnedValue(map).get(1).answer,42);
 const set=new Set([1,2,3]);
 set[Symbol.iterator]=()=>[][Symbol.iterator]();
 assert.deepEqual([...copyOwnedValue(set)],[1,2,3]);
});
test('shared backing, cyclic records and byte receipt compatibility',()=>{
 const b=new ArrayBuffer(1024);
 const v=copyOwnedValueWithBytes({first:new Uint8Array(b),second:new DataView(b)});
 assert.equal(v.bytes,1046);
 assert.equal(v.value.first.buffer,v.value.second.buffer);
 const original={n:42};original.self=original;
 const cloned=copyOwnedValue(original);
 assert.equal(cloned.self,cloned);
});
test('RegExp fake source accessor fails closed without access invocation',()=>{
 let calls=0;const r=/abc/;
 Object.defineProperty(r,'source',{get(){calls++;return 'hidden'}});
 assert.throws(()=>copyOwnedValue(r),/accessors forbidden/);
 assert.equal(calls,0);
});
test('byte size and complexity bounds preserve prior profile',()=>{
 assert.throws(()=>copyOwnedValue(new Uint8Array(8*1024*1024+1)),/byte budget exceeded/);
 assert.throws(()=>copyOwnedValue(new Map(Array.from({length:8200},(_,i)=>[i,true]))),/complexity exceeded/);
});
