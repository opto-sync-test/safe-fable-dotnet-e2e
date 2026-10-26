import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {spawnNodeActor} from '../src/actor-host.node.mjs';
const moduleUrl=new URL('./fixtures/worker-handler.mjs',import.meta.url).href;
const PROTOCOL='ores.js.worker.v1';
test('two real Node Workers preserve FIFO, ownership, and sibling lifecycle',async()=>{
 const a=spawnNodeActor({moduleUrl,maxPending:2,maxPendingBytes:1024});
 const b=spawnNodeActor({moduleUrl,maxPending:2,maxPendingBytes:1024});
 try{
  await Promise.all([a.ready,b.ready]);
  const f=a.request({type:'sleep',ms:45,n:1n});
  const g=a.request({type:'add',x:40n,y:2n});
  await assert.rejects(a.request({type:'tell'}),/capacity exceeded/);
  assert.equal(await b.request({type:'add',x:20n,y:22n}),42n);
  assert.deepEqual(await Promise.all([f,g]),[1n,42n]);
  assert.equal(a.pendingBytes,0);
  const payload={items:[{answer:42}],arr:new Uint8Array([5,6])};
  const result=a.request({type:'echo',payload});payload.items[0].answer=99;payload.arr[0]=80;
  assert.deepEqual((await result).items,[{answer:42}]);
  assert.equal(a.pendingBytes,0);
  await a.close();
  assert.equal(await b.request({type:'add',x:40n,y:2n}),42n);
 }finally{await Promise.all([a.close(),b.close()]);}
});
test('real Worker accepts allowed Date and boxed scalars but rejects unsupported Error before posting',async()=>{
 const actor=spawnNodeActor({moduleUrl,maxPendingBytes:1000});
 try{
  await actor.ready;
  const value={when:new Date(1234),boxed:Object(42n),primitive:3n};
  const output=await actor.request({type:'echo',payload:value});
  assert.equal(output.when.getTime(),1234);
  assert.equal(output.boxed.valueOf(),42n);
  await assert.rejects(actor.request({type:'echo',payload:new Error('forbidden')}),/unsupported actor wire object type/);
  assert.equal(actor.pendingBytes,0);
  assert.equal(await actor.request({type:'add',x:20n,y:22n}),42n);
 }finally{await actor.close();}
});
test('real Worker byte credit released on guest errors, results, and terminal close',async()=>{
 const actor=spawnNodeActor({moduleUrl,maxPending:3,maxPendingBytes:600});
 try{
  await actor.ready;
  const first=actor.request({type:'sleep',ms:40,n:1n,padding:'x'.repeat(200)});
  assert.ok(actor.pendingBytes>400);
  await assert.rejects(actor.request({type:'add',x:1n,y:2n,padding:'y'.repeat(200)}),/byte capacity exceeded/);
  assert.equal(await first,1n);assert.equal(actor.pendingBytes,0);
  await assert.rejects(actor.request({type:'crash',padding:'x'.repeat(200)}),/intentional handler error/);
  assert.equal(actor.pendingBytes,0);
  assert.equal(await actor.request({type:'add',x:40n,y:2n}),42n);
  const pending=actor.request({type:'sleep',ms:1000,n:2n});
  const rejected=assert.rejects(pending,/actor closed/);
  await actor.close();await rejected;
  assert.equal(actor.pendingBytes,0);
 }finally{await actor.close();}
});
test('real raw Worker endpoint revokes session on inbound unsupported error',async()=>{
 const worker=new Worker(new URL('../src/worker-actor.node.mjs',import.meta.url),{type:'module',execArgv:[]});
 try{
  const inbox=[];
  const next=()=>new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('endpoint response timed out')),3000);
    worker.once('message',msg=>{clearTimeout(timeout);inbox.push(msg);resolve(msg);});
  });
  worker.postMessage({protocol:PROTOCOL,kind:'init',moduleUrl,mode:'handler',exportName:'receive',maxPending:2,maxPendingBytes:1024});
  const ready=await next();assert.equal(ready.kind,'ready');
  worker.postMessage({protocol:PROTOCOL,kind:'deliver',id:1,reply:true,value:{type:'echo',payload:new Error('forbidden')}});
  const fatal=await next();assert.equal(fatal.kind,'fatal');
  assert.match(fatal.error,/invalid actor delivery payload/);
  worker.postMessage({protocol:PROTOCOL,kind:'deliver',id:2,reply:true,value:{type:'add',x:40n,y:2n}});
  await new Promise(r=>setTimeout(r,60));assert.deepEqual(inbox.map(x=>x.kind),['ready','fatal']);
 }finally{await worker.terminate();}
});

test('forged native Errors fail before real Worker admission without killing siblings',async()=>{
  const a=spawnNodeActor({moduleUrl,maxPending:3,maxPendingBytes:2048});
  const b=spawnNodeActor({moduleUrl,maxPending:3,maxPendingBytes:2048});
  try{
    await Promise.all([a.ready,b.ready]);
    const err=new Error('not a plain record');
    Object.setPrototypeOf(err,Object.prototype);
    await assert.rejects(
      a.request({type:'echo',payload:err}),
      /unsupported actor wire object type/
    );
    assert.equal(a.pending,0);
    assert.equal(a.pendingBytes,0);
    const spoof=new Error('do not evaluate tag');
    Object.setPrototypeOf(spoof,Object.prototype);
    delete spoof.stack;
    Object.defineProperty(spoof,Symbol.toStringTag,{value:'Object'});
    await assert.rejects(
      a.request({type:'echo',payload:spoof}),
      /unsupported actor wire symbol key/
    );
    assert.equal(a.pendingBytes,0);
    assert.equal(await a.request({type:'add',x:40n,y:2n}),42n);
    assert.equal(await b.request({type:'add',x:40n,y:2n}),42n);
  }finally{await Promise.all([a.close(),b.close()]);}
});
