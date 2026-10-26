import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {compileProgramV2,compileToProgramIRV2,compileProgramIRV2} from '../src/program-v2.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..','contracts','scalar','v1');
const manifestBytes=await readFile(join(root,'cases.json'));
const corpus=JSON.parse(manifestBytes.toString('utf8'));
const EXPECTED_SUITE_SHA256='5b5d1bc00def9b3a343cb3281e0bb0be4e5ca438095f621141049e2d7a1a25b3';

test('shared scalar parity corpus has the exact .NET/Wasm reviewed bytes',async()=>{
  assert.equal(corpus.schema_version,'1.0.0');
  assert.equal(corpus.cases.length,11);
  const hash=createHash('sha256').update(manifestBytes);
  const ids=new Set();
  let accepts=0,rejects=0;
  for(const c of corpus.cases){
    assert.match(c.id,/^[a-z][a-z0-9.-]{1,79}$/);
    assert.ok(!ids.has(c.id),'duplicate case id: '+c.id);
    ids.add(c.id);
    assert.match(c.file,/^fixtures\/[a-z0-9-]+\.ores$/);
    const bytes=await readFile(join(root,c.file));
    assert.ok(bytes.length>0&&bytes.length<=1048576,'invalid fixture size: '+c.file);
    hash.update(Buffer.from(c.file,'ascii'));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    if(c.kind==='accept')accepts++;
    else if(c.kind==='reject')rejects++;
    else assert.fail('unknown case kind: '+c.kind);
  }
  assert.equal(accepts,6);
  assert.equal(rejects,5);
  assert.equal(hash.digest('hex'),EXPECTED_SUITE_SHA256);
});

for(const c of corpus.cases.filter(c=>c.kind==='accept')){
  test('shared scalar executable parity: '+c.id,async()=>{
    const source=await readFile(join(root,c.file),'utf8');
    const ir=compileToProgramIRV2(source);
    const esm=compileProgramV2(source);
    assert.equal(compileProgramIRV2(JSON.parse(JSON.stringify(ir))),esm,
      'source and validated program IR must emit identical ESM');
    const {main}=await import('data:text/javascript,'+encodeURIComponent(esm));
    assert.equal(main(),BigInt(c.value));
  });
}

for(const c of corpus.cases.filter(c=>c.kind==='reject')){
  test('shared scalar fail-closed parity: '+c.id,async()=>{
    const source=await readFile(join(root,c.file),'utf8');
    assert.throws(()=>compileProgramV2(source),/error: program v2:|error: program IR:/);
  });
}

// The shared corpus intentionally excludes overflow pending cross-backend policy
// alignment. JS program-v2 nevertheless keeps its checked-i64 behavior pinned
// locally so parity work cannot accidentally turn wrap/trap differences silent.
for(const [name,expression] of [
  ['add overflow','9223372036854775807 + 1'],
  ['subtract overflow','-9223372036854775808 - 1'],
  ['multiply overflow','9223372036854775807 * 2'],
  ['unary negate minimum','-(-9223372036854775808)'],
]){
  test('program-v2 checked-i64 trap: '+name,async()=>{
    const esm=compileProgramV2('pub fnc main(): int { return '+expression+'; }');
    const {main}=await import('data:text/javascript,'+encodeURIComponent(esm));
    assert.throws(()=>main(),/ORES_I64_OVERFLOW/);
  });
}
