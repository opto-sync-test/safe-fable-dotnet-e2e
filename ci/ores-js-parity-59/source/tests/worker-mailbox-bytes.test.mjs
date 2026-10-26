import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createWorkerActorClient} from '../src/worker-actor-client.mjs';
import {installWorkerActorEndpoint} from '../src/worker-actor-endpoint.mjs';
import {spawnNodeActor} from '../src/actor-host.node.mjs';

const PROTOCOL='ores.js.worker.v1';
const moduleUrl=new URL('./fixtures/worker-handler.mjs',import.meta.url).href;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pad=n=>({args:[1n,2n],padding:'x'.repeat(n)});
class StubWorker extends EventEmitter {
  sent=[];terminations=0;failDeliver=false;
  postMessage(message){
    if(this.failDeliver&&message.kind==='deliver')throw Error('send failed');
    this.sent.push(message);
  }
  terminate(){this.terminations++;return Promise.resolve(0);}
  frame(kind,rest={}){this.emit('message',{protocol:PROTOCOL,kind,...rest});}
}
const client=(worker,opts={})=>createWorkerActorClient({
  worker,moduleUrl:'file:///trusted/add.mjs',exportName:'add',mode:'call',
  maxPending:4,maxPendingBytes:60000,...opts
});

test('client reserves bytes before ready and releases them after successful result',async()=>{
  const w=new StubWorker(),a=client(w);
  const first=a.request(pad(20000));
  assert.ok(a.pendingBytes>40000);
  await assert.rejects(a.request(pad(20000)),/mailbox byte capacity exceeded/);
  assert.equal(a.pending,1);
  w.frame('ready');await a.ready;
  await Promise.resolve();
  const sent=w.sent.find(m=>m.kind==='deliver');
  assert.equal(sent.id,1);
  w.frame('result',{id:1,ok:true,value:3n});
  assert.equal(await first,3n);
  assert.equal(a.pendingBytes,0);
  assert.equal(a.pending,0);
  const again=a.request(pad(20000));await Promise.resolve();
  w.frame('result',{id:2,ok:true,value:3n});
  assert.equal(await again,3n);
  assert.equal(a.pendingBytes,0);
  await a.close();
});

test('client releases byte reservations after handler errors and post failures',async()=>{
  const w=new StubWorker(),a=client(w);
  w.frame('ready');await a.ready;
  const first=a.request(pad(20000));await Promise.resolve();
  w.frame('result',{id:1,ok:false,error:'guest error'});
  await assert.rejects(first,/guest error/);
  assert.equal(a.pendingBytes,0);
  w.failDeliver=true;
  const failed=a.request(pad(20000));
  await assert.rejects(failed,/send failed/);
  assert.equal(a.pendingBytes,0);
  assert.equal(a.pending,0);
  await a.close();
});

test('client frees outstanding reservations on close and rejects future sends',async()=>{
  const w=new StubWorker(),a=client(w);
  w.frame('ready');await a.ready;
  const first=a.request(pad(18000));
  const rejected=assert.rejects(first,/actor closed/);
  assert.ok(a.pendingBytes>35000);
  await a.close();await rejected;
  assert.equal(a.pendingBytes,0);
  assert.equal(a.pending,0);
  await assert.rejects(a.request(pad(100)),/actor closed/);
});

test('malformed response and fatal event revoke all outstanding byte credit',async()=>{
  for(const cause of ['fatal','bad']){
    const w=new StubWorker(),a=client(w,{maxPendingBytes:100000});
    w.frame('ready');await a.ready;
    const a1=a.request(pad(20000)),a2=a.request(pad(20000));
    const rejected1=assert.rejects(a1,/actor startup|unexpected actor response id/);
    const rejected2=assert.rejects(a2,/actor startup|unexpected actor response id/);
    if(cause==='fatal')w.frame('fatal',{error:'broken'});
    else w.frame('result',{id:999,ok:true,value:null});
    await Promise.all([rejected1,rejected2]);
    assert.equal(a.pendingBytes,0);
    assert.equal(a.pending,0);
    await a.close();
  }
});

test('endpoint independently enforces aggregate byte limit and suppresses late replies',async()=>{
  let send;const replies=[];
  installWorkerActorEndpoint({subscribe:cb=>{send=cb;},post:frame=>replies.push(frame)});
  const frame=(kind,extra={})=>send({protocol:PROTOCOL,kind,...extra});
  frame('init',{moduleUrl,exportName:'receive',mode:'handler',
    maxPending:4,maxPendingBytes:65000});
  for(let i=0;i<100&&!replies.some(x=>x.kind==='ready');i++)await sleep(3);
  assert.equal(replies.at(-1)?.kind,'ready');
  frame('deliver',{id:1,reply:true,value:{type:'sleep',ms:50,n:1n,padding:'x'.repeat(20000)}});
  frame('deliver',{id:2,reply:true,value:{type:'add',x:1n,y:2n,padding:'x'.repeat(20000)}});
  assert.equal(replies.at(-1)?.kind,'fatal');
  assert.match(replies.at(-1)?.error,/byte capacity exceeded/);
  await sleep(65);
  assert.equal(replies.filter(x=>x.kind==='result').length,0);
});

test('endpoint releases reserved bytes on handler completion and recoverable failure',async()=>{
  let send;const replies=[];
  installWorkerActorEndpoint({subscribe:cb=>{send=cb;},post:frame=>replies.push(frame)});
  const frame=(kind,extra={})=>send({protocol:PROTOCOL,kind,...extra});
  const until=async(n)=>{for(let i=0;i<200;i++){
    if(replies.filter(x=>x.kind==='result').length>=n)return;
    await sleep(2);
  }assert.fail('result timed out');};
  frame('init',{moduleUrl,exportName:'receive',mode:'handler',
    maxPending:4,maxPendingBytes:60000});
  for(let i=0;i<100&&!replies.some(x=>x.kind==='ready');i++)await sleep(3);
  assert.equal(replies.at(-1)?.kind,'ready');
  frame('deliver',{id:1,reply:true,value:{type:'crash',padding:'x'.repeat(20000)}});
  await until(1);
  assert.equal(replies.at(-1).ok,false);
  frame('deliver',{id:2,reply:true,value:{type:'add',x:40n,y:2n,padding:'x'.repeat(20000)}});
  await until(2);
  assert.equal(replies.at(-1).value,42n);
  assert.equal(replies.filter(x=>x.kind==='fatal').length,0);
});

test('real Node Worker mailbox byte budget and sibling isolation',async()=>{
  const a=spawnNodeActor({moduleUrl,maxPending:4,maxPendingBytes:64000});
  const b=spawnNodeActor({moduleUrl,maxPending:4,maxPendingBytes:64000});
  try{
    await Promise.all([a.ready,b.ready]);
    const first=a.request({type:'sleep',ms:55,n:1n,padding:'x'.repeat(20000)});
    assert.ok(a.pendingBytes>40000);
    await assert.rejects(a.request({type:'add',x:40n,y:2n,padding:'x'.repeat(20000)}),
      /mailbox byte capacity exceeded/);
    assert.equal(await b.request({type:'add',x:40n,y:2n}),42n);
    assert.equal(await first,1n);
    assert.equal(a.pendingBytes,0);
    assert.equal(await a.request({type:'add',x:40n,y:2n,padding:'x'.repeat(20000)}),42n);
    assert.equal(a.pendingBytes,0);
    await assert.rejects(a.request({type:'crash',padding:'x'.repeat(20000)}),
      /intentional handler error/);
    assert.equal(a.pendingBytes,0);
  }finally{await Promise.all([a.close(),b.close()]);}
});

test('reject invalid aggregate-byte configuration at both protocol boundaries',async()=>{
  for(const maxPendingBytes of [0,-1,1.5,Number.MAX_SAFE_INTEGER,256*1024*1024+1]){
    assert.throws(()=>client(new StubWorker(),{maxPendingBytes}),
      /invalid actor mailbox byte limit/);
    let receive;const frames=[];
    installWorkerActorEndpoint({
      subscribe:cb=>{receive=cb;},post:f=>frames.push(f)
    });
    receive({protocol:PROTOCOL,kind:'init',moduleUrl,
      exportName:'receive',mode:'handler',maxPending:4,maxPendingBytes});
    assert.equal(frames.length,1);
    assert.equal(frames[0].kind,'fatal');
    assert.match(frames[0].error,/invalid actor module descriptor/);
  }
});
