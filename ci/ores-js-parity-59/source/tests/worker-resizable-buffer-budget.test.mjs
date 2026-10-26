import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnNodeActor} from '../src/actor-host.node.mjs';
import {copyOwnedValue,copyOwnedValueWithBytes} from '../src/worker-actor-copy.mjs';
const MiB=1024*1024;
const handler=new URL('./fixtures/worker-handler.mjs',import.meta.url).href;
function beforeClone(value,pattern){
  const original=globalThis.structuredClone;
  let clones=0;
  globalThis.structuredClone=x=>{clones++;return original(x);};
  try {assert.throws(()=>copyOwnedValue(value),pattern);assert.equal(clones,0);}
  finally {globalThis.structuredClone=original;}
}
test('zero-length resizable buffer with giant maximum is rejected before cloning',()=>{
  const b=new ArrayBuffer(0,{maxByteLength:1024*MiB});
  assert.equal(b.byteLength,0);
  assert.equal(b.maxByteLength,1024*MiB);
  beforeClone(b,/byte budget exceeded/);
});
test('small current length cannot conceal growth capacity above the message limit',()=>{
  beforeClone(new ArrayBuffer(32,{maxByteLength:9*MiB}),/byte budget exceeded/);
});
test('instance-provided capacity getter and changed prototype cannot conceal intrinsic growth capacity',()=>{
  const b=new ArrayBuffer(0,{maxByteLength:16*MiB});
  let calls=0;
  Object.defineProperty(b,'maxByteLength',{get(){calls++;return 0;}});
  Object.setPrototypeOf(b,Object.prototype);
  beforeClone(b,/byte budget exceeded/);
  assert.equal(calls,0);
});
test('valid resizable buffer is charged for capacity and remains independently resizable after copy',()=>{
  const original=new ArrayBuffer(2,{maxByteLength:128});
  new Uint8Array(original)[0]=42;
  const receipt=copyOwnedValueWithBytes(original);
  assert.equal(receipt.bytes,128);
  assert.equal(receipt.value.maxByteLength,128);
  assert.equal(new Uint8Array(receipt.value)[0],42);
  receipt.value.resize(128);
  assert.equal(receipt.value.byteLength,128);
  assert.equal(original.byteLength,2);
});
test('fixed-length buffers retain original byte receipts, aliases to resizable backing only charge once',()=>{
  const fixed=copyOwnedValueWithBytes(new ArrayBuffer(64));
  assert.equal(fixed.bytes,64);
  const backing=new ArrayBuffer(1,{maxByteLength:128});
  const record=copyOwnedValueWithBytes({a:backing,b:new Uint8Array(backing),c:backing});
  assert.equal(record.bytes,2+2+2+128);
  assert.equal(record.value.a,record.value.b.buffer);
  assert.equal(record.value.a,record.value.c);
});
test('real Node Worker respects resizable capacity mailbox credit and remains usable',async()=>{
  const actor=spawnNodeActor({moduleUrl:handler,maxPendingBytes:100});
  try{
    await actor.ready;
    await assert.rejects(actor.request({type:'echo',payload:new ArrayBuffer(0,{maxByteLength:1024})}),
      /mailbox byte capacity exceeded/);
    assert.equal(actor.pending,0);
    assert.equal(actor.pendingBytes,0);
    assert.equal(await actor.request({type:'echo',payload:7}),7);
    assert.equal(actor.pendingBytes,0);
  }finally{await actor.close();}
});
