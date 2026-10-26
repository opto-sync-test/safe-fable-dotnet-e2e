import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnNodeActor} from '../src/actor-host.node.mjs';
import {copyOwnedValue,copyOwnedValueWithBytes} from '../src/worker-actor-copy.mjs';

const MiB=1024*1024;
const handler=new URL('./fixtures/worker-handler.mjs',import.meta.url).href;
function beforeClone(value,pattern){
  const original=globalThis.structuredClone;
  let clones=0;
  globalThis.structuredClone=v=>{clones++;return original(v);};
  try{assert.throws(()=>copyOwnedValue(value),pattern);assert.equal(clones,0);}
  finally{globalThis.structuredClone=original;}
}

test('zero-byte Blob with oversized MIME type is rejected before cloning',()=>{
  const blob=new Blob([],{type:'a'.repeat(4*MiB+1)});
  assert.equal(blob.size,0);
  assert.equal(blob.type.length,4*MiB+1);
  beforeClone(blob,/byte budget exceeded/);
});

test('overridden Blob.type does not hide internal cloneable metadata',()=>{
  const blob=new Blob([],{type:'b'.repeat(4*MiB+1)});
  let getters=0;
  Object.defineProperty(blob,'type',{get(){getters++;return '';}});
  Object.setPrototypeOf(blob,Object.prototype);
  beforeClone(blob,/byte budget exceeded/);
  assert.equal(getters,0);
});

test('small Blob charges both payload and UTF-16 MIME metadata',()=>{
  const b=new Blob([new Uint8Array(12)],{type:'application/test'});
  const actual=copyOwnedValueWithBytes(b);
  assert.equal(actual.bytes,12+2*b.type.length);
  assert.equal(actual.value.type,'application/test');
  assert.equal(actual.value.size,12);
});

test('nested distinct Blobs sum their MIME metadata while aliases charge once',()=>{
  const a=new Blob([new Uint8Array(3)],{type:'x'.repeat(80)});
  const b=new Blob([],{type:'y'.repeat(70)});
  const receipt=copyOwnedValueWithBytes({a,b,again:a});
  // object keys: a=2, b=2, again=10 UTF-16 bytes
  assert.equal(receipt.bytes,2+2+10+3+80*2+70*2);
  assert.equal(receipt.value.a,receipt.value.again);
});

test('real Node Worker reserves MIME metadata and refuses undersized mailbox',async()=>{
  const actor=spawnNodeActor({moduleUrl:handler,maxPendingBytes:100});
  try{
    await actor.ready;
    const type='a'.repeat(100);
    const blob=new Blob([],{type});
    await assert.rejects(actor.request({type:'echo',payload:blob}),/mailbox byte capacity exceeded/);
    assert.equal(actor.pendingBytes,0);
    assert.equal(actor.pending,0);
    const result=await actor.request({type:'echo',payload:7});
    assert.equal(result,7);
    assert.equal(actor.pendingBytes,0);
  }finally{await actor.close();}
});
