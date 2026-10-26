import test from 'node:test';
import assert from 'node:assert/strict';
import {copyOwnedValue,copyOwnedValueWithBytes} from '../src/worker-actor-copy.mjs';

const MiB=1024*1024;

test('binary payload at byte-budget boundary is copied without aliases',()=>{
  const source=new Uint8Array(8*MiB-14); // 14 UTF-16 bytes for the "payload" key
  source[0]=42;
  const clone=copyOwnedValue({payload:source});
  source[0]=99;
  assert.equal(clone.payload[0],42);
  assert.notEqual(clone.payload.buffer,source.buffer);
});

test('oversized typed arrays and backing ArrayBuffers are rejected before clone',()=>{
  const original=globalThis.structuredClone;
  let cloneCalls=0;
  globalThis.structuredClone=(value)=>{cloneCalls++;return original(value);};
  try{
    assert.throws(()=>copyOwnedValue(new Uint8Array(8*MiB+1)),/byte budget exceeded/);
    assert.throws(()=>copyOwnedValue(new ArrayBuffer(8*MiB+1)),/byte budget exceeded/);
    assert.equal(cloneCalls,0);
  }finally{globalThis.structuredClone=original;}
});

test('nested Blob, oversized UTF-16 strings and repeated graph ownership are bounded',()=>{
  if(typeof Blob==='function')
    assert.throws(()=>copyOwnedValue({binary:new Blob([new Uint8Array(8*MiB+1)])}),/byte budget exceeded/);
  assert.throws(()=>copyOwnedValue('x'.repeat(4*MiB+1)),/byte budget exceeded/);
  const backing=new ArrayBuffer(5*MiB);
  const value={left:new Uint8Array(backing),right:new DataView(backing)};
  const cloned=copyOwnedValue(value);
  assert.equal(cloned.left.buffer,cloned.right.buffer);
  assert.notEqual(cloned.left.buffer,backing);
});

test('reject accessors without executing them or invoking structuredClone',()=>{
  let getterCalls=0;
  const hostile=Object.defineProperty({},'payload',{
    enumerable:true,get(){getterCalls++;return new ArrayBuffer(16*MiB);}
  });
  const original=globalThis.structuredClone;
  let cloneCalls=0;
  globalThis.structuredClone=(value)=>{cloneCalls++;return original(value);};
  try{
    assert.throws(()=>copyOwnedValue(hostile),/accessors forbidden/);
    assert.equal(getterCalls,0);
    assert.equal(cloneCalls,0);
  }finally{globalThis.structuredClone=original;}
});

test('reject nested shared memory before clone and preserve cyclic owned graphs',()=>{
  if(typeof SharedArrayBuffer==='function'){
    const original=globalThis.structuredClone;
    let cloneCalls=0;
    globalThis.structuredClone=(value)=>{cloneCalls++;return original(value);};
    try{
      assert.throws(
        ()=>copyOwnedValue({m:new Map([['bad',new Uint8Array(new SharedArrayBuffer(8))]])}),
        /shared-memory/);
      assert.equal(cloneCalls,0);
    }finally{globalThis.structuredClone=original;}
  }
  const original={answer:42};
  original.self=original;
  const cloned=copyOwnedValue(original);
  assert.notEqual(cloned,original);
  assert.equal(cloned.self,cloned);
});

test('complex graphs are rejected before clone',()=>{
  const original=globalThis.structuredClone;
  let cloneCalls=0;
  globalThis.structuredClone=(value)=>{cloneCalls++;return original(value);};
  try{
    assert.throws(()=>copyOwnedValue(Array.from({length:8200},()=>({ok:true}))),/complexity exceeded/);
    const top={},root=top;let p=top;
    for(let i=0;i<67;i++){p.child={};p=p.child;}
    assert.throws(()=>copyOwnedValue(root),/complexity exceeded/);
    assert.equal(cloneCalls,0);
  }finally{globalThis.structuredClone=original;}
});

test('wide primitive-only arrays and Map/Set entries reject before clone',()=>{
  const original=globalThis.structuredClone;
  let calls=0;
  globalThis.structuredClone=value=>{calls++;return original(value);};
  try{
    assert.throws(()=>copyOwnedValue(Array.from({length:8200},(_,i)=>i)),/complexity exceeded/);
    assert.throws(()=>copyOwnedValue(new Map(Array.from({length:8200},(_,i)=>[i,true]))),/complexity exceeded/);
    assert.throws(()=>copyOwnedValue(new Set(Array.from({length:8200},(_,i)=>i))),/complexity exceeded/);
    assert.equal(calls,0);
  }finally{globalThis.structuredClone=original;}
});

test('copy receipt measures owned snapshot bytes and counts shared backing only once',()=>{
  const bytes=new ArrayBuffer(1024);
  const receipt=copyOwnedValueWithBytes({
    first:new Uint8Array(bytes),second:new DataView(bytes)
  });
  // UTF-16 key bytes: first=10, second=12, backing=1024.
  assert.equal(receipt.bytes,1046);
  assert.equal(receipt.value.first.buffer,receipt.value.second.buffer);
  assert.notEqual(receipt.value.first.buffer,bytes);
  assert.equal(Object.isFrozen(receipt),true);
  assert.equal(copyOwnedValueWithBytes('hello').bytes,10);
});


test('large RegExp patterns and arbitrarily wide bigint values consume budgets before clone',()=>{
  const original=globalThis.structuredClone;
  let cloneCalls=0;
  globalThis.structuredClone=(value)=>{cloneCalls++;return original(value);};
  try{
    const largePattern=new RegExp('a'.repeat(4*MiB+1));
    assert.throws(()=>copyOwnedValue(largePattern),/byte budget exceeded/);
    const wide=BigInt('0x'+'f'.repeat(16*MiB+2));
    assert.throws(()=>copyOwnedValue(wide),/byte budget exceeded/);
    assert.throws(()=>copyOwnedValue(Object(wide)),/byte budget exceeded/);
    assert.equal(cloneCalls,0);
  }finally{globalThis.structuredClone=original;}
});

test('RegExp built-in source accounting ignores hostile overridden source getter',()=>{
  let getterCalls=0;
  const pattern=/abc/;
  Object.defineProperty(pattern,'source',{get(){getterCalls++;return 'evil';}});
  assert.throws(()=>copyOwnedValue(pattern),/accessors forbidden/);
  assert.equal(getterCalls,0);
  assert.ok(copyOwnedValueWithBytes(/abc/).bytes>=6);
  assert.ok(copyOwnedValueWithBytes(2n**256n).bytes>=33);
  assert.ok(copyOwnedValueWithBytes(Object(2n**256n)).bytes>=33);
});

test('spoofed built-in size and buffer properties cannot hide cloneable bytes',()=>{
  const original=globalThis.structuredClone;
  let cloned=0;
  globalThis.structuredClone=value=>{cloned++;return original(value);};
  try{
    const oversized=9*MiB;
    const b=Object.defineProperty(new ArrayBuffer(oversized),'byteLength',{value:0});
    const blob=Object.defineProperty(new Blob([new Uint8Array(oversized)]),'size',{value:0});
    const typed=Object.defineProperty(new Uint8Array(oversized),'buffer',{value:new ArrayBuffer(0)});
    const view=Object.defineProperty(new DataView(new ArrayBuffer(oversized)),'buffer',{value:new ArrayBuffer(0)});
    const map=new Map([['large',new Uint8Array(oversized)]]);
    map[Symbol.iterator]=()=>[][Symbol.iterator]();
    const set=new Set([new Uint8Array(oversized)]);
    set[Symbol.iterator]=()=>[][Symbol.iterator]();
    for(const value of [b,blob,typed,view,map,set])
      assert.throws(()=>copyOwnedValue(value),/byte budget exceeded/);
    assert.equal(cloned,0);
  }finally{globalThis.structuredClone=original;}
});

test('built-in readers preserve the correct bounded Map/Set and view semantics',()=>{
  const backing=new ArrayBuffer(1000);
  const view=Object.defineProperty(new DataView(backing),'buffer',{value:new ArrayBuffer(0)});
  assert.equal(copyOwnedValueWithBytes(view).bytes,1000);
  const map=new Map([[1,{answer:42}]]);
  map[Symbol.iterator]=()=>[][Symbol.iterator]();
  const mapped=copyOwnedValue(map);
  assert.equal(mapped.get(1).answer,42);
  const set=new Set([1,2,3]);
  set[Symbol.iterator]=()=>[][Symbol.iterator]();
  assert.deepEqual([...copyOwnedValue(set)],[1,2,3]);
});

test('cloneable internal slots cannot hide behind changed object prototypes',()=>{
  const size=9*MiB;
  const kinds=[
    new ArrayBuffer(size),
    new Uint8Array(size),
    new DataView(new ArrayBuffer(size)),
    new Map([['buffer',new ArrayBuffer(size)]]),
    new Set([new ArrayBuffer(size)]),
    new RegExp('a'.repeat(4*MiB+1)),
    Object('x'.repeat(4*MiB+1))
  ];
  const original=globalThis.structuredClone;
  let cloneCalls=0;
  globalThis.structuredClone=(value)=>{cloneCalls++;return original(value);};
  try{
    for(const value of kinds){
      Object.setPrototypeOf(value,Object.prototype);
      assert.throws(()=>copyOwnedValue(value),/byte budget exceeded/);
    }
    if(typeof SharedArrayBuffer==='function'){
      const shared=new SharedArrayBuffer(8);
      Object.setPrototypeOf(shared,Object.prototype);
      assert.throws(()=>copyOwnedValue(shared),/shared-memory/);
    }
    assert.equal(cloneCalls,0);
  }finally{globalThis.structuredClone=original;}
});

test('small cloneables remain supported after prototype changes',()=>{
  const map=new Map([['answer',42]]);
  const set=new Set([1,2,3]);
  const pattern=/hello/i;
  const backing=new ArrayBuffer(16);
  const boxed=Object('hello');
  for(const item of [map,set,pattern,backing,boxed])
    Object.setPrototypeOf(item,Object.prototype);
  assert.equal(copyOwnedValue(map).get('answer'),42);
  assert.deepEqual([...copyOwnedValue(set)],[1,2,3]);
  assert.equal(copyOwnedValue(pattern).source,'hello');
  assert.equal(copyOwnedValue(backing).byteLength,16);
  assert.equal(copyOwnedValue(boxed).valueOf(),'hello');
});
