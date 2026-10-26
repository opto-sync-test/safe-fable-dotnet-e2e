import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkerActorEndpoint} from '../src/worker-actor-endpoint.mjs';

const PROTOCOL='ores.js.worker.v1';
const MODULE_URL=new URL('./fixtures/worker-handler.mjs',import.meta.url).href;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function harness(){
  let listener;
  const frames=[];
  installWorkerActorEndpoint({
    subscribe(callback){listener=callback;},
    post(frame){frames.push(frame);}
  });
  const send=(kind,extra={})=>listener({protocol:PROTOCOL,kind,...extra});
  const raw=frame=>listener(frame);
  const init=(extra={})=>send('init',{
    moduleUrl:MODULE_URL,exportName:'receive',mode:'handler',
    maxPending:2,maxPendingBytes:32*1024*1024,...extra
  });
  const until=async(predicate,timeout=1000)=>{
    const deadline=Date.now()+timeout;
    while(!predicate()){
      if(Date.now()>deadline)assert.fail('Worker endpoint reply timed out');
      await sleep(2);
    }
  };
  return {frames,send,raw,init,until};
}

test('endpoint serializes deliveries with bounded in-flight credit and snapshots inbound bytes',async()=>{
  const h=harness();h.init();
  await h.until(()=>h.frames.some(f=>f.kind==='ready'));
  const source={type:'add',x:40n,y:2n};
  h.send('deliver',{id:1,reply:true,value:{type:'sleep',ms:35,n:1n}});
  h.send('deliver',{id:2,reply:true,value:source});
  source.x=999n;
  await h.until(()=>h.frames.filter(f=>f.kind==='result').length===2);
  assert.deepEqual(h.frames.filter(f=>f.kind==='result').map(f=>f.id),[1,2]);
  assert.deepEqual(h.frames.filter(f=>f.kind==='result').map(f=>f.value),[1n,42n]);
  assert.equal(h.frames.filter(f=>f.kind==='fatal').length,0);
});

test('in-flight capacity counts executing turn; overflow seals session and suppresses late replies',async()=>{
  const h=harness();h.init({maxPending:1});
  await h.until(()=>h.frames.some(f=>f.kind==='ready'));
  h.send('deliver',{id:1,reply:true,value:{type:'sleep',ms:45,n:1n}});
  h.send('deliver',{id:2,reply:true,value:{type:'add',x:20n,y:22n}});
  await h.until(()=>h.frames.some(f=>f.kind==='fatal'));
  assert.match(h.frames.find(f=>f.kind==='fatal').error,/capacity exceeded/);
  await sleep(65);
  assert.equal(h.frames.filter(f=>f.kind==='result').length,0);
  const prior=h.frames.length;
  h.send('deliver',{id:3,reply:true,value:{type:'add',x:1n,y:2n}});
  assert.equal(h.frames.length,prior);
});

test('duplicate and non-monotonic delivery IDs terminally fail protocol',async()=>{
  const h=harness();h.init();
  await h.until(()=>h.frames.some(f=>f.kind==='ready'));
  h.send('deliver',{id:2,reply:true,value:{type:'add',x:40n,y:2n}});
  await h.until(()=>h.frames.some(f=>f.kind==='result'));
  h.send('deliver',{id:2,reply:true,value:{type:'add',x:40n,y:2n}});
  await h.until(()=>h.frames.some(f=>f.kind==='fatal'));
  assert.match(h.frames.find(f=>f.kind==='fatal').error,/invalid or premature delivery/);
  assert.equal(h.frames.filter(f=>f.kind==='result').length,1);
});

test('malformed frames and wrong protocol trigger exactly one fatal event',()=>{
  const h=harness();
  h.raw({protocol:'wrong',kind:'init'});
  h.raw({protocol:PROTOCOL,kind:'init'});
  h.raw(null);
  assert.deepEqual(h.frames.map(f=>f.kind),['fatal']);
});

test('premature delivery fences asynchronous initialization and forbids ready',async()=>{
  const h=harness();
  h.init();
  h.send('deliver',{id:1,reply:true,value:{type:'add',x:40n,y:2n}});
  await h.until(()=>h.frames.some(f=>f.kind==='fatal'));
  await sleep(25);
  assert.deepEqual(h.frames.map(f=>f.kind),['fatal']);
});

test('duplicate initialization seals even a previously ready endpoint',async()=>{
  const h=harness();h.init();
  await h.until(()=>h.frames.some(f=>f.kind==='ready'));
  h.init();
  assert.deepEqual(h.frames.map(f=>f.kind),['ready','fatal']);
});

test('invalid maxPending and invalid delivery payload fail closed',async()=>{
  const bad=harness();bad.init({maxPending:0});
  assert.equal(bad.frames[0].kind,'fatal');
  const valid=harness();valid.init();
  await valid.until(()=>valid.frames.some(f=>f.kind==='ready'));
  if(typeof SharedArrayBuffer==='function'){
    valid.send('deliver',{id:1,reply:true,value:{
      type:'echo',payload:new Map([['shared',new Uint8Array(new SharedArrayBuffer(8))]])
    }});
    assert.equal(valid.frames.at(-1).kind,'fatal');
    assert.match(valid.frames.at(-1).error,/invalid actor delivery payload/);
  }else{
    valid.send('deliver',{id:1,reply:true,value:{type:'echo',payload:9}});
    await valid.until(()=>valid.frames.some(f=>f.kind==='result'));
  }
});

test('handler error reports a single failed result and leaves endpoint usable',async()=>{
  const h=harness();h.init();
  await h.until(()=>h.frames.some(f=>f.kind==='ready'));
  h.send('deliver',{id:1,reply:true,value:{type:'crash'}});
  await h.until(()=>h.frames.some(f=>f.kind==='result'));
  assert.equal(h.frames.find(f=>f.kind==='result').ok,false);
  assert.match(h.frames.find(f=>f.kind==='result').error,/intentional handler error/);
  h.send('deliver',{id:2,reply:true,value:{type:'add',x:40n,y:2n}});
  await h.until(()=>h.frames.filter(f=>f.kind==='result').length===2);
  assert.equal(h.frames.at(-1).value,42n);
});

test('pre-ready invalid frame makes late import completion inert',async()=>{
  const h=harness();
  h.raw({protocol:PROTOCOL,kind:'unexpected'});
  h.init();
  await sleep(20);
  assert.deepEqual(h.frames.map(f=>f.kind),['fatal']);
});
