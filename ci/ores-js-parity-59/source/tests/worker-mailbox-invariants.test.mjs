import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createWorkerActorClient} from '../src/worker-actor-client.mjs';
import {copyOwnedValueWithBytes} from '../src/worker-actor-copy.mjs';
const PROTOCOL='ores.js.worker.v1';
class WorkerStub extends EventEmitter{
  sent=[];terminated=0;failDelivery=false;
  postMessage(frame){if(this.failDelivery&&frame.kind==='deliver')throw Error('send failed');this.sent.push(frame);}
  terminate(){this.terminated++;return Promise.resolve(0);}
  frame(kind,more={}){this.emit('message',{protocol:PROTOCOL,kind,...more});}
}
const spawn=(worker,maxPending=16,maxPendingBytes=6000)=>createWorkerActorClient({worker,moduleUrl:'file:///trusted/mock.mjs',maxPending,maxPendingBytes});
const charge=value=>copyOwnedValueWithBytes(value).bytes;
const next=()=>new Promise(resolve=>queueMicrotask(resolve));
test('pre-ready limits reserve only accepted messages; shutdown refunds all',async()=>{
  const w=new WorkerStub(),a=spawn(w,3,600);
  const value={type:'x',payload:'z'.repeat(100)};
  const cost=charge(value);
  const tasks=[a.request(value),a.tell(value)];
  const rejection=tasks.map(p=>assert.rejects(p,/actor closed/));
  assert.equal(a.pendingBytes,cost*2);assert.equal(a.pending,2);
  await assert.rejects(a.request({payload:'q'.repeat(500)}),/byte capacity exceeded/);
  assert.equal(a.pendingBytes,cost*2);assert.equal(a.pending,2);
  await a.close();await Promise.all(rejection);
  assert.equal(a.pendingBytes,0);assert.equal(a.pending,0);
  w.frame('ready');w.frame('result',{id:1,ok:true,value:5});
  assert.equal(a.pendingBytes,0);assert.equal(w.terminated,1);
});
test('out-of-order success, negative receipt and tell return exact byte credit',async()=>{
  const w=new WorkerStub(),a=spawn(w,8,9000);
  w.frame('ready');await a.ready;
  const msgs=Array.from({length:5},(_,i)=>({i,padding:'x'.repeat((i+1)*40)}));
  const tasks=msgs.map((msg,i)=>i===4?a.tell(msg):a.request(msg));
  const charges=msgs.map(charge);
  assert.equal(a.pendingBytes,charges.reduce((a,b)=>a+b,0));
  assert.equal(a.pending,5);await next();
  const outcomes=tasks.map(p=>p.then(v=>({ok:true,value:v}),e=>({ok:false,message:e.message})));
  for(const id of [5,3,1,4,2]){
    const idx=id-1;
    w.frame('result',id===3?{id,ok:false,error:'guest error'}:{id,ok:true,value:idx+10});
    charges[idx]=0;
    assert.equal(a.pendingBytes,charges.reduce((x,y)=>x+y,0));
    assert.equal(a.pending,charges.filter(x=>x>0).length);
  }
  const results=await Promise.all(outcomes);
  assert.deepEqual(results.map(x=>x.ok),[true,true,false,true,true]);
  assert.equal(results[4].value,undefined);
  await a.close();
});
test('send failures refund credits and keep other outstanding IDs live',async()=>{
  const w=new WorkerStub(),a=spawn(w,4,1000);w.frame('ready');await a.ready;
  const first=a.request({p:'a'.repeat(40)});await next();
  const retained=a.pendingBytes;
  w.failDelivery=true;
  await assert.rejects(a.request({p:'b'.repeat(60)}),/send failed/);
  assert.equal(a.pending,1);assert.equal(a.pendingBytes,retained);
  w.frame('result',{id:1,ok:true,value:42});assert.equal(await first,42);
  assert.equal(a.pendingBytes,0);await a.close();
});
test('unexpected response and malformed response revoke all outstanding credit once',async()=>{
  for(const cause of ['unknown','invalid-success']){
    const w=new WorkerStub(),a=spawn(w,5,2000);w.frame('ready');await a.ready;
    const tasks=[a.request({p:'x'.repeat(200)}),a.request({p:'y'.repeat(200)})];
    const rejected=tasks.map(p=>assert.rejects(p,/unexpected actor response id|invalid actor response payload/));
    if(cause==='unknown')w.frame('result',{id:99,ok:true,value:42});
    else w.frame('result',{id:1,ok:true,value:new Error('unsupported')});
    await Promise.all(rejected);
    assert.equal(a.pendingBytes,0);assert.equal(a.pending,0);
    w.frame('result',{id:1,ok:true,value:2});
    assert.equal(a.pendingBytes,0);
    assert.equal(w.terminated,1);
    await a.close();
  }
});
test('worker exit and messageerror settle every receipt and never refund twice',async()=>{
  for(const cause of ['exit','messageerror']){
    const w=new WorkerStub(),a=spawn(w,8,10000);w.frame('ready');await a.ready;
    const tasks=[a.request({p:'a'.repeat(200)}),a.tell({p:'b'.repeat(200)})];
    const rejected=tasks.map(p=>assert.rejects(p,/worker exited|worker message decoding failure/));
    w.emit(cause,cause==='exit'?5:new Error('decode'));
    await Promise.all(rejected);
    assert.equal(a.pendingBytes,0);assert.equal(a.pending,0);
    await a.close();assert.equal(a.pendingBytes,0);
  }
});
test('seeded 256-step admission/receipt lifecycle respects reservation invariants',async()=>{
  const w=new WorkerStub(),a=spawn(w,10,4000);w.frame('ready');await a.ready;
  let seed=0x12345678;
  const rng=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
  const pending=new Map();
  const settled=[];
  let id=0;
  for(let step=0;step<256;step++){
    const closeOne=pending.size&&(rng()%3===0||pending.size===10);
    if(closeOne){
      const ids=[...pending.keys()];const chosen=ids[rng()%ids.length];
      const entry=pending.get(chosen);
      if(rng()%7===0)w.frame('result',{id:chosen,ok:false,error:'failed'});
      else w.frame('result',{id:chosen,ok:true,value:chosen});
      pending.delete(chosen);
    }else{
      const msg={id:step,payload:'a'.repeat(20+(rng()%110))};
      const size=charge(msg);
      const affordable=a.pendingBytes+size<=4000;
      if(affordable&&pending.size<10){
        id++;
        const p=a.request(msg);
        settled.push(p.then(()=>{},()=>{}));
        pending.set(id,size);
      }else await assert.rejects(a.request(msg),/capacity exceeded/);
    }
    assert.equal(a.pending,pending.size);
    assert.equal(a.pendingBytes,[...pending.values()].reduce((x,y)=>x+y,0));
    assert.ok(a.pendingBytes>=0&&a.pendingBytes<=4000);
    await next();
  }
  w.frame('fatal',{error:'test teardown'});
  await Promise.all(settled); // All promises resolved or revoked by fatal.
  assert.equal(a.pending,0);assert.equal(a.pendingBytes,0);
  await a.close();
});
