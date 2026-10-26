import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createWorkerActorClient} from '../src/worker-actor-client.mjs';
import {installWorkerActorEndpoint} from '../src/worker-actor-endpoint.mjs';

const PROTOCOL = 'ores.js.worker.v1';
const moduleUrl = new URL('./fixtures/worker-handler.mjs', import.meta.url).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class StubNodeWorker extends EventEmitter {
  count = 0;
  postMessage() {}
  terminate() {this.count++;return Promise.resolve(0);}
}
function client(w) {return createWorkerActorClient({worker:w,moduleUrl,maxPending:3,maxPendingBytes:1024});}
function getterBomb(key) {
  const frame={protocol:PROTOCOL,kind:'result',id:1,ok:true,value:42};
  Object.defineProperty(frame,key,{get(){throw Error('injected getter exception');}});
  return frame;
}
for(const key of ['protocol','kind','id','ok','error']) {
  test('Node client traps an accessor-throwing '+key+' frame and refunds credit',async()=>{
    const w=new StubNodeWorker(),a=client(w);
    w.emit('message',{protocol:PROTOCOL,kind:'ready'});
    await a.ready;
    const promise=a.request({type:'add',x:40n,y:2n});
    const reject=assert.rejects(promise,/invalid actor frame/);
    const frame=key==='error'?{protocol:PROTOCOL,kind:'fatal'}:getterBomb(key);
    if(key==='error')Object.defineProperty(frame,'error',{get(){throw Error('injected getter exception');}});
    assert.doesNotThrow(()=>w.emit('message',frame));
    await reject;
    assert.equal(a.pending,0);
    assert.equal(a.pendingBytes,0);
    assert.equal(w.count,1);
    assert.doesNotThrow(()=>w.emit('message',{protocol:PROTOCOL,kind:'result',id:1,ok:true,value:42}));
    await a.close();
  });
}
test('client startup frame getter failure settles ready and queued receipt',async()=>{
  const w=new StubNodeWorker(),a=client(w);
  const ready=assert.rejects(a.ready,/invalid actor frame/);
  const pending=assert.rejects(a.request({type:'add',x:40n,y:2n}),/invalid actor frame/);
  assert.ok(a.pendingBytes>0);
  assert.doesNotThrow(()=>w.emit('message',getterBomb('protocol')));
  await Promise.all([ready,pending]);
  assert.equal(a.pendingBytes,0);
  assert.equal(a.pending,0);
  await a.close();
});
test('browser Worker malformed message data getter revokes receipt',async()=>{
  class BrowserStub {
    listener; count=0;
    addEventListener(name,fn){if(name==='message')this.listener=fn;}
    postMessage(){}
    terminate(){this.count++;}
  }
  const w=new BrowserStub(),a=client(w);
  w.listener({data:{protocol:PROTOCOL,kind:'ready'}});await a.ready;
  const pending=assert.rejects(a.request({msg:'x'}),/invalid actor frame/);
  assert.doesNotThrow(()=>w.listener({get data(){throw Error('getter bomb');}}));
  await pending;
  assert.equal(a.pendingBytes,0);
  assert.equal(w.count,1);
  await a.close();
});
test('endpoint malformed init getter emits one fatal frame and suppresses later init',()=>{
  let send;const frames=[];
  installWorkerActorEndpoint({subscribe:f=>send=f,post:f=>frames.push(f)});
  assert.doesNotThrow(()=>send({get protocol(){throw Error('getter bomb');}}));
  assert.equal(frames.length,1);
  assert.equal(frames[0].kind,'fatal');
  assert.match(frames[0].error,/invalid actor frame/);
  send({protocol:PROTOCOL,kind:'init',moduleUrl,mode:'handler',exportName:'receive',maxPending:2,maxPendingBytes:1000});
  assert.equal(frames.length,1);
});
test('endpoint accessor-throwing delivery seals active turn and suppresses late result',async()=>{
  let send;const frames=[];
  installWorkerActorEndpoint({subscribe:f=>send=f,post:f=>frames.push(f)});
  send({protocol:PROTOCOL,kind:'init',moduleUrl,mode:'handler',exportName:'receive',maxPending:2,maxPendingBytes:1000});
  for(let i=0;i<200&&!frames.find(f=>f.kind==='ready');i++) await sleep(2);
  assert.ok(frames.some(f=>f.kind==='ready'));
  send({protocol:PROTOCOL,kind:'deliver',id:1,reply:true,value:{type:'sleep',ms:50,n:1n}});
  assert.doesNotThrow(()=>send({protocol:PROTOCOL,kind:'deliver',get id(){throw Error('getter bomb');}}));
  await sleep(75);
  assert.deepEqual(frames.map(f=>f.kind),['ready','fatal']);
});
