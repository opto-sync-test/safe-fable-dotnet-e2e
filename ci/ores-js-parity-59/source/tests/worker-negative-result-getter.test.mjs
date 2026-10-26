import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createWorkerActorClient} from '../src/worker-actor-client.mjs';
const PROTOCOL='ores.js.worker.v1';
class Stub extends EventEmitter {
  terminated=0;
  postMessage(){}
  terminate(){this.terminated++;return Promise.resolve(0);}
}
const actorFor=worker=>createWorkerActorClient({worker,moduleUrl:'file:///trusted/mock.mjs',maxPending:4,maxPendingBytes:1024});
function poisonedFrame(id){
  const frame={protocol:PROTOCOL,kind:'result',id,ok:false};
  Object.defineProperty(frame,'error',{get(){throw Error('poisoned result.error');}});
  return frame;
}
async function settles(promise){
  return Promise.race([promise.then(()=>({kind:'resolve'}), e=>({kind:'reject',message:e.message})),
    new Promise(r=>setTimeout(()=>r({kind:'timeout'}),120))]);
}
test('negative-result accessor failure rejects released request instead of orphaning it',async()=>{
  const worker=new Stub(),actor=actorFor(worker);
  worker.emit('message',{protocol:PROTOCOL,kind:'ready'});await actor.ready;
  const first=actor.request({payload:'x'.repeat(15)});
  assert.ok(actor.pendingBytes>0);
  assert.doesNotThrow(()=>worker.emit('message',poisonedFrame(1)));
  assert.deepEqual(await settles(first),{kind:'reject',message:'invalid actor frame'});
  assert.equal(actor.pending,0);assert.equal(actor.pendingBytes,0);
  assert.equal(worker.terminated,1);
  await actor.close();
});
test('negative-result accessor failure revokes all outstanding credits and terminal-fences late results',async()=>{
  const worker=new Stub(),actor=actorFor(worker);
  worker.emit('message',{protocol:PROTOCOL,kind:'ready'});await actor.ready;
  const first=actor.request({payload:'x'}),second=actor.tell({payload:'y'});
  assert.equal(actor.pending,2);
  worker.emit('message',poisonedFrame(1));
  assert.deepEqual(await Promise.all([settles(first),settles(second)]),[
    {kind:'reject',message:'invalid actor frame'},
    {kind:'reject',message:'invalid actor frame'}]);
  assert.equal(actor.pending,0);assert.equal(actor.pendingBytes,0);
  worker.emit('message',{protocol:PROTOCOL,kind:'result',id:2,ok:true,value:8});
  assert.equal(actor.pending,0);assert.equal(worker.terminated,1);
  await actor.close();
});
test('browser-style Worker malformed negative receipt also rejects',async()=>{
  class BrowserStub {
    listeners=new Map(); terminated=0;
    addEventListener(key,callback){this.listeners.set(key,callback);}
    postMessage(){}
    terminate(){this.terminated++;}
    frame(data){this.listeners.get('message')({data});}
  }
  const worker=new BrowserStub(),actor=actorFor(worker);
  worker.frame({protocol:PROTOCOL,kind:'ready'});await actor.ready;
  const pending=actor.request({msg:42});
  worker.frame(poisonedFrame(1));
  assert.deepEqual(await settles(pending),{kind:'reject',message:'invalid actor frame'});
  assert.equal(actor.pending,0);assert.equal(actor.pendingBytes,0);
  assert.equal(worker.terminated,1);
  await actor.close();
});
test('normal negative delivery only settles its own receipt, subsequent success survives',async()=>{
  const worker=new Stub(),actor=actorFor(worker);
  worker.emit('message',{protocol:PROTOCOL,kind:'ready'});await actor.ready;
  const first=actor.request({msg:1}),second=actor.request({msg:2});
  worker.emit('message',{protocol:PROTOCOL,kind:'result',id:1,ok:false,error:'guest failed'});
  assert.deepEqual(await settles(first),{kind:'reject',message:'actor delivery failed: guest failed'});
  assert.equal(actor.pending,1);
  worker.emit('message',{protocol:PROTOCOL,kind:'result',id:2,ok:true,value:42});
  assert.equal(await second,42);
  assert.equal(actor.pending,0);assert.equal(actor.pendingBytes,0);
  await actor.close();
});
for(const negative of [false,true]) {
  test('response ID is captured once before '+(negative?'negative':'successful')+' settlement',async()=>{
    const worker=new Stub(),actor=actorFor(worker);
    worker.emit('message',{protocol:PROTOCOL,kind:'ready'});await actor.ready;
    const first=actor.request({request:1}),second=actor.request({request:2});
    let idReads=0;
    const frame={protocol:PROTOCOL,kind:'result',ok:!negative};
    if(negative)frame.error='denied';else frame.value=42;
    Object.defineProperty(frame,'id',{get(){idReads++;return idReads===1?1:2;}});
    worker.emit('message',frame);
    if(negative)assert.deepEqual(await settles(first),{kind:'reject',message:'actor delivery failed: denied'});
    else assert.equal(await first,42);
    assert.equal(idReads,1,'a result must not consult mutable id more than once');
    assert.equal(actor.pending,1);
    assert.ok(actor.pendingBytes>0);
    worker.emit('message',{protocol:PROTOCOL,kind:'result',id:2,ok:true,value:99});
    assert.equal(await second,99);
    assert.equal(actor.pending,0);assert.equal(actor.pendingBytes,0);
    await actor.close();
  });
}
