import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createWorkerActorClient} from '../src/worker-actor-client.mjs';

const PROTOCOL='ores.js.worker.v1';
class StubWorker extends EventEmitter {
  sent=[];terminated=0;
  postMessage(frame){this.sent.push(frame);}
  terminate(){this.terminated++;return Promise.resolve(0);}
  frame(kind,rest={}){this.emit('message',{protocol:PROTOCOL,kind,...rest});}
}
function client(worker){return createWorkerActorClient({worker,moduleUrl:'file:///trusted/mock.mjs',maxPending:4});}
const nullProto=()=>Object.create(null);

for(const bad of [nullProto,()=>({message:nullProto()}),()=>({get message(){throw new Error('getter bomb');}})]){
  test('fatal with unstringifiable worker error settles ready and all queued receipts',async()=>{
    const worker=new StubWorker(),actor=client(worker);
    const ready=assert.rejects(actor.ready,/actor startup\/protocol failure/);
    const r=assert.rejects(actor.request({n:1}),/actor startup\/protocol failure/);
    worker.frame('fatal',{error:bad()});
    await Promise.all([ready,r]);
    assert.equal(actor.pending,0);
    assert.equal(actor.pendingBytes,0);
    assert.equal(worker.terminated,1);
    await actor.close();
  });
}
test('negative result with nonstringifiable error settles exactly one receipt and permits later work',async()=>{
  const worker=new StubWorker(),actor=client(worker);
  worker.frame('ready');await actor.ready;
  const failed=actor.request({n:1});
  worker.frame('result',{id:1,ok:false,error:nullProto()});
  await assert.rejects(failed,/actor delivery failed: uninspectable actor failure/);
  assert.equal(actor.pendingBytes,0);
  const next=actor.request({n:2});
  worker.frame('result',{id:2,ok:true,value:42n});
  assert.equal(await next,42n);
  assert.equal(actor.pending,0);
  await actor.close();
});
test('worker error event with unstringifiable message cannot strand pending receipts',async()=>{
  const worker=new StubWorker(),actor=client(worker);
  worker.frame('ready');await actor.ready;
  const failed=assert.rejects(actor.request({n:1}),/worker execution failure: uninspectable actor failure/);
  worker.emit('error',{get message(){throw new Error('getter bomb');}});
  await failed;
  assert.equal(actor.pending,0);
  assert.equal(actor.pendingBytes,0);
  assert.equal(worker.terminated,1);
  await actor.close();
});
