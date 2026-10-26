import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnNodeActor} from '../src/actor-host.node.mjs';

const moduleUrl=new URL('./fixtures/worker-handler.mjs',import.meta.url).href;

test('two real Node Workers execute independently with bounded serialized mailboxes',async()=>{
  const a=spawnNodeActor({moduleUrl,maxPending:2});
  const b=spawnNodeActor({moduleUrl,maxPending:2});
  try{
    await Promise.all([a.ready,b.ready]);
    const first=a.request({type:'sleep',ms:40,n:1n});
    const second=a.request({type:'add',x:40n,y:2n});
    await assert.rejects(a.request({type:'add',x:1n,y:1n}),/capacity exceeded/);
    assert.equal(await b.request({type:'add',x:21n,y:21n}),42n);
    assert.deepEqual(await Promise.all([first,second]),[1n,42n]);
    assert.equal(a.pending,0);
  }finally{await Promise.all([a.close(),b.close()]);}
});

test('real Node Worker copies payloads and keeps going after a handler error',async()=>{
  const a=spawnNodeActor({moduleUrl,maxPending:2});
  try{
    await a.ready;
    const payload={n:1};
    const reply=a.request({type:'echo',payload});
    payload.n=99;
    assert.deepEqual(await reply,{n:1});
    assert.deepEqual(await a.request({type:'reply-snapshot'}),{n:1});
    await assert.rejects(a.request({type:'crash'}),/intentional handler error/);
    await assert.rejects(a.request({type:'missing-done'}),/self.done/);
    if(typeof SharedArrayBuffer==='function')
      await assert.rejects(a.request({type:'echo',payload:new SharedArrayBuffer(8)}),/shared-memory/);
    assert.equal(await a.request({type:'add',x:40n,y:2n}),42n);
  }finally{await a.close();}
});

test('close revokes pending real-Worker request without affecting sibling Worker',async()=>{
  const a=spawnNodeActor({moduleUrl});
  const b=spawnNodeActor({moduleUrl});
  try{
    await Promise.all([a.ready,b.ready]);
    const rejected=assert.rejects(a.request({type:'sleep',ms:2000,n:1n}),/actor closed/);
    await a.close();
    await rejected;
    assert.equal(await b.request({type:'add',x:40n,y:2n}),42n);
  }finally{await Promise.all([a.close(),b.close()]);}
});
