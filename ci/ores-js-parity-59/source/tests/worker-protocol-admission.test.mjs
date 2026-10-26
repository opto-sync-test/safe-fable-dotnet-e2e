import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createWorkerActorClient} from '../src/worker-actor-client.mjs';

const PROTOCOL='ores.js.worker.v1';
class StubNodeWorker extends EventEmitter {
  posted=[];
  terminated=0;
  postMessage(frame){this.posted.push(frame);}
  terminate(){this.terminated++;return Promise.resolve(0);}
  frame(kind,extra={}){this.emit('message',{protocol:PROTOCOL,kind,...extra});}
}
class StubBrowserWorker {
  posted=[];
  terminated=0;
  callbacks=new Map();
  addEventListener(name,listener){this.callbacks.set(name,listener);}
  postMessage(frame){this.posted.push(frame);}
  terminate(){this.terminated++;}
  emit(name,data){this.callbacks.get(name)?.({data});}
}
const client=worker=>createWorkerActorClient({
  worker,moduleUrl:'file:///trusted/generated.mjs',exportName:'add',mode:'call',maxPending:2
});
const nextTurn=()=>new Promise(resolve=>queueMicrotask(resolve));

test('wrong-protocol, unknown and premature response frames revoke queued receipts',async()=>{
  for(const invalid of [
    {protocol:'unexpected',kind:'ready'},
    {protocol:PROTOCOL,kind:'unrecognized'},
    null,
    {protocol:PROTOCOL,kind:'result',id:1,ok:true,value:42n}
  ]) {
    const worker=new StubNodeWorker(),actor=client(worker);
    const readyRejected=assert.rejects(actor.ready,/invalid actor frame|actor result before ready/);
    const queued=actor.request({args:[40n,2n]});
    const receiptRejected=assert.rejects(queued,/invalid actor frame|actor result before ready/);
    worker.emit('message',invalid);
    await Promise.all([readyRejected,receiptRejected]);
    assert.equal(actor.pending,0);
    assert.equal(worker.terminated,1);
    await assert.rejects(actor.request({args:[1n,1n]}),/actor closed/);
    await actor.close();
  }
});

test('unexpected response IDs and malformed ok flags fail closed after ready',async()=>{
  for(const bogus of [
    {kind:'result',id:999,ok:true,value:42n},
    {kind:'result',id:1,ok:'true',value:42n}
  ]) {
    const worker=new StubNodeWorker(),actor=client(worker);
    worker.frame('ready');
    await actor.ready;
    const rejected=assert.rejects(actor.request({args:[40n,2n]}),
      /unexpected actor response id|invalid actor response/);
    await nextTurn();
    assert.equal(worker.posted.length,2);
    worker.frame(bogus.kind,bogus);
    await rejected;
    assert.equal(actor.pending,0);
    assert.equal(worker.terminated,1);
    await actor.close();
  }
});

test('duplicate ready, decoding failure and execution error revoke pending',async()=>{
  for(const reason of ['duplicate','messageerror','error']) {
    const worker=new StubNodeWorker(),actor=client(worker);
    worker.frame('ready');
    await actor.ready;
    const rejected=assert.rejects(actor.request({args:[42n,0n]}),
      /duplicate actor ready|decoding failure|execution failure/);
    await nextTurn();
    if(reason==='duplicate')worker.frame('ready');
    else if(reason==='messageerror')worker.emit('messageerror',new Error('decode'));
    else worker.emit('error',new Error('crash'));
    await rejected;
    assert.equal(actor.pending,0);
    assert.equal(worker.terminated,1);
    await actor.close();
  }
});

test('close revokes inflight work and stale replies cannot revive the actor',async()=>{
  const worker=new StubNodeWorker(),actor=client(worker);
  worker.frame('ready');
  await actor.ready;
  const rejected=assert.rejects(actor.request({args:[40n,2n]}),/actor closed/);
  await nextTurn();
  assert.equal(worker.posted.at(-1).kind,'deliver');
  await actor.close();
  await rejected;
  worker.frame('result',{id:1,ok:true,value:42n});
  assert.equal(actor.pending,0);
  await assert.rejects(actor.request({args:[1n,2n]}),/actor closed/);
});

test('pre-ready admission snapshots messages and bounds the inflight mailbox',async()=>{
  const worker=new StubNodeWorker(),actor=client(worker);
  const payload={args:[40n,2n],nested:{value:1}};
  const first=assert.rejects(actor.request(payload),/actor closed/);
  payload.args[0]=999n;
  payload.nested.value=999;
  const second=assert.rejects(actor.request({args:[21n,21n]}),/actor closed/);
  await assert.rejects(actor.request({args:[1n,2n]}),/mailbox capacity exceeded/);
  worker.frame('ready');
  await actor.ready;
  await nextTurn();
  assert.equal(worker.posted.length,3);
  assert.equal(worker.posted[1].value.args[0],40n);
  assert.equal(worker.posted[1].value.nested.value,1);
  await actor.close();
  await Promise.all([first,second]);
});

test('Browser Worker malformed frame and error paths also terminate',async()=>{
  for(const name of ['error','messageerror','invalid']) {
    const worker=new StubBrowserWorker(),actor=client(worker);
    worker.emit('message',{protocol:PROTOCOL,kind:'ready'});
    await actor.ready;
    const rejection=assert.rejects(actor.request({args:[40n,2n]}),
      /execution failure|decoding failure|invalid actor frame/);
    await nextTurn();
    if(name==='invalid')worker.emit('message',{protocol:PROTOCOL,kind:'unknown'});
    else worker.emit(name);
    await rejection;
    assert.equal(actor.pending,0);
    assert.equal(worker.terminated,1);
    await actor.close();
  }
});

test('successful Worker replies are snapped before resolving caller promises',async()=>{
  const worker=new StubNodeWorker(),actor=client(worker);
  worker.frame('ready');
  await actor.ready;
  const received=actor.request({args:[1n,2n]});
  await nextTurn();
  const mutable={items:[{answer:42}],buffer:new Uint8Array([1,2])};
  worker.frame('result',{id:1,ok:true,value:mutable});
  mutable.items[0].answer=999;
  mutable.buffer[0]=255;
  const reply=await received;
  assert.deepEqual(reply.items,[{answer:42}]);
  assert.deepEqual([...reply.buffer],[1,2]);
  assert.notEqual(reply,mutable);
  assert.equal(actor.pending,0);
  await actor.close();
});

test('successful shared-memory Worker responses fail closed without leaking aliases',async()=>{
  if(typeof SharedArrayBuffer!=='function')return;
  for(const payload of [
    new SharedArrayBuffer(8),
    {nested:new Map([['alias',new Uint8Array(new SharedArrayBuffer(8))]])}
  ]){
    const worker=new StubNodeWorker(),actor=client(worker);
    worker.frame('ready');
    await actor.ready;
    const rejection=assert.rejects(actor.request({args:[1n,2n]}),
      /invalid actor response payload/);
    await nextTurn();
    worker.frame('result',{id:1,ok:true,value:payload});
    await rejection;
    assert.equal(actor.pending,0);
    assert.equal(worker.terminated,1);
    await assert.rejects(actor.request({args:[1n,2n]}),/actor closed/);
    await actor.close();
  }
});

test('successful Worker responses exceeding complexity budget revoke pending receipts',async()=>{
  const worker=new StubNodeWorker(),actor=client(worker);
  worker.frame('ready');
  await actor.ready;
  const rejection=assert.rejects(actor.request({args:[1n,2n]}),
    /invalid actor response payload/);
  await nextTurn();
  worker.frame('result',{id:1,ok:true,
    value:{items:Array.from({length:8200},()=>({flag:true}))}});
  await rejection;
  assert.equal(actor.pending,0);
  assert.equal(worker.terminated,1);
  await actor.close();
});
