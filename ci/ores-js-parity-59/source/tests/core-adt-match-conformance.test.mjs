import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileFreestandingCore} from '../src/freestanding-core.mjs';

const sourcePath=new URL('./fixtures/conformance-option-result-match-i64-v0.ores',import.meta.url);
const manifestPath=new URL('./fixtures/conformance-option-result-match-i64-v0.json',import.meta.url);
const SOURCE_BLOB='248e8e95896315a203b3a729e079241d8b53d7de';
const MANIFEST_BLOB='7400986b537d57bf5ae2c26988caffabf6ab6632';
const gitBlob=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');

async function pinnedFixture(){
  const [source,manifest]=await Promise.all([readFile(sourcePath),readFile(manifestPath)]);
  assert.equal(gitBlob(source),SOURCE_BLOB,'conformance .ores drifted');
  assert.equal(gitBlob(manifest),MANIFEST_BLOB,'conformance manifest drifted');
  const spec=JSON.parse(manifest.toString('utf8'));
  assert.equal(spec.schema,'oreslang.portable-adt-match-i64.v0');
  assert.deepEqual(spec.confirmedBackends,[]);
  assert.deepEqual(spec.capabilityRequirements,[]);
  assert.equal(spec.testVectors.length,27);
  assert.equal(spec.negativeCases.length,9);
  return {source:source.toString('utf8'),spec};
}

test('exact shared ADT matching contract executes in Node ESM, including lazy arms',async()=>{
  const {source,spec}=await pinnedFixture();
  const esm=compileFreestandingCore(source);
  assert.doesNotMatch(esm,/^\s*import\b/m);
  const {core}=await import('data:text/javascript,'+encodeURIComponent(esm));
  for(const v of spec.testVectors){
    const result=core[v.function](...v.args.map(BigInt));
    assert.equal(typeof result,'bigint',v.id);
    assert.deepEqual({int:String(result)},v.expected,v.id);
  }
  assert.throws(()=>core.lazy_some(7),/BigInt/);
  assert.throws(()=>core.lazy_ok(1n<<63n),/OVERFLOW/);
});

test('exact shared nine negative cases reject for semantic reasons, not generic parse failure',async()=>{
  const {spec}=await pinnedFixture();
  const diagnostic={
    'missing-none':/non-exhaustive ADT match/,
    'duplicate-some':/duplicate match pattern Some/,
    'mixed-families':/cannot mix Option and Result variant patterns/,
    'wrong-subject':/parameter type mismatch/,
    'parameter-shadow':/ADT payload binding shadows an existing name/,
    'nested-shadow':/ADT payload binding shadows an existing name/,
    'none-has-no-payload':/None has no payload/,
    'wrong-return-type':/ADT int payload capture type mismatch/,
    'wildcard-instead-of-none':/ADT match requires exhaustive named variants/
  };
  assert.deepEqual(new Set(spec.negativeCases.map(c=>c.id)),new Set(Object.keys(diagnostic)));
  for(const v of spec.negativeCases){
    assert.equal(v.expect,'reject');
    assert.throws(()=>compileFreestandingCore(v.source),diagnostic[v.id],v.id);
  }
});
