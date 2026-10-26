import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnNodeActor} from '../src/actor-host.node.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/worker-guest-i64.ores',import.meta.url));
const COMPILER = fileURLToPath(new URL('../bin/oreslang-jsc.mjs',import.meta.url));
const EXPECTED_BLOB = '8c2acdb4c21ec5572aba4e48253413ba3a86c071';

test('source fixture is exact-byte pinned: changing guest source requires review',async()=>{
  const bytes=await readFile(FIXTURE);
  const gitBlob=createHash('sha1').update('blob '+bytes.byteLength+'\0')
    .update(bytes).digest('hex');
  assert.equal(gitBlob,EXPECTED_BLOB);
});

test('actual Oreslang source compiles through CLI and executes inside two distinct Node Workers',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'oreslang-js-guest-'));
  const guest=join(temp,'generated.mjs');
  let actorA,actorB;
  try{
    const compiled=spawnSync(process.execPath,[COMPILER,'--program-v2',FIXTURE,
      '--out='+guest],{encoding:'utf8',timeout:20000,maxBuffer:65536});
    assert.equal(compiled.status,0,compiled.stderr);
    assert.equal(compiled.signal,null);
    assert.equal(compiled.error,undefined);
    assert.equal(compiled.stdout,''); // CLI never masquerades as executed guest output.
    assert.ok((await stat(guest)).size>0);
    const moduleUrl=pathToFileURL(guest).href;
    actorA=spawnNodeActor({moduleUrl,exportName:'add',mode:'call'});
    actorB=spawnNodeActor({moduleUrl,exportName:'add',mode:'call'});
    await Promise.all([actorA.ready,actorB.ready]);
    assert.deepEqual(await Promise.all([
      actorA.request({args:[40n,2n]}),
      actorB.request({args:[21n,21n]}),
      actorA.request({args:[-9n,6n]}),
      actorB.request({args:[9n,-6n]})
    ]),[42n,42n,-3n,3n]);
    await assert.rejects(actorA.request({args:[(1n<<63n)-1n,1n]}),/OVERFLOW/);
    await assert.rejects(actorB.request({args:[40,2n]}),/BigInt/);
    // A guest overflow is a recoverable call result, not a Worker fatal.
    assert.equal(await actorA.request({args:[1n,2n]}),3n);
    await assert.rejects(actorA.request({args:[1n]}),/arity/);
    assert.equal(await actorB.request({args:[2n,40n]}),42n);
    if(typeof SharedArrayBuffer==='function'){
      // Nested shared memory cannot cross this copy-only message boundary.
      await assert.rejects(actorB.request({args:[new SharedArrayBuffer(8),2n]}),
        /shared-memory/);
      assert.equal(await actorB.request({args:[40n,2n]}),42n);
    }
    await actorA.close();
    actorA=null;
    assert.equal(await actorB.request({args:[40n,2n]}),42n);
  }finally{
    if(actorA)await actorA.close();
    if(actorB)await actorB.close();
    await rm(temp,{recursive:true,force:true});
  }
});

test('unsupported source-level actor declaration fails without producing guest artifact',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'oreslang-js-negative-'));
  try{
    const source=join(temp,'actor.ores');
    const target=join(temp,'must-not-exist.mjs');
    await writeFile(source,
      'define actor Worker as\n  state {}\nend\n',
      {mode:0o600});
    const compiled=spawnSync(process.execPath,[COMPILER,'--program-v2',source,
      '--out='+target],{encoding:'utf8',timeout:10000,maxBuffer:65536});
    assert.notEqual(compiled.status,0,'source actor syntax must remain unsupported');
    assert.ok(compiled.stderr.length>0);
    await assert.rejects(stat(target),e=>e?.code==='ENOENT');
  }finally{await rm(temp,{recursive:true,force:true});}
});

// Closing the client revokes pending reply authority; it does NOT prove
// execution-level cancellation of an already running guest turn.
test('closing one Node Worker revokes pending delivery without affecting sibling Worker',async()=>{
  const moduleUrl=new URL('./fixtures/worker-handler.mjs',import.meta.url).href;
  let actorA=spawnNodeActor({moduleUrl}), actorB=spawnNodeActor({moduleUrl});
  try {
    await Promise.all([actorA.ready,actorB.ready]);
    const pending=actorA.request({type:'sleep',ms:1500,n:7n});
    const rejected=assert.rejects(pending,/actor closed/);
    await actorA.close();
    actorA=null;
    await rejected;
    assert.equal(await actorB.request({type:'add',x:40n,y:2n}),42n);
  } finally {
    if(actorA)await actorA.close();
    if(actorB)await actorB.close();
  }
});
