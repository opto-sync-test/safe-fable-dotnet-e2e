import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  resolveBrowserWorkerFixture,readBrowserWorkerFixture,
  BrowserWorkerFixtureAccessError
} from '../scripts/browser-worker-fixture-path.mjs';

async function withSandbox(callback){
  const root=await mkdtemp(join(tmpdir(),'ores-js-browser-policy-'));
  try{
    await mkdir(join(root,'src'),{recursive:true});
    await mkdir(join(root,'tests','fixtures'),{recursive:true});
    await mkdir(join(root,'.github','workflows'),{recursive:true});
    await writeFile(join(root,'src','compiler.mjs'),'export const answer=42;');
    await writeFile(join(root,'tests','fixtures','worker.ores'),'pub fnc f(): int {return 42;}');
    await writeFile(join(root,'tests','worker.html'),'<!doctype html>');
    await writeFile(join(root,'tests','.hidden.mjs'),'should never be served');
    await writeFile(join(root,'secret.mjs'),'secret content');
    await writeFile(join(root,'.github','workflows','secrets.mjs'),'secret content');
    await writeFile(join(root,'tests','fixtures','wrong.json'),'{}');
    await writeFile(join(root,'tests','fixtures','oversized.mjs'),'x'.repeat(1048577));
    await mkdir(join(root,'src','directory.mjs'));
    await symlink(join(root,'secret.mjs'),join(root,'src','escaped.mjs'));
    await symlink(join(root,'tests','.hidden.mjs'),join(root,'src','hidden-alias.mjs'));
    await symlink(join(root,'tests','worker.html'),join(root,'src','allowed.html'));
    await symlink(join(root,'tests','fixtures'),join(root,'src','alias'));
    await callback(root);
  }finally{await rm(root,{recursive:true,force:true});}
}
const denied=async(root,url)=>{
  await assert.rejects(resolveBrowserWorkerFixture(root,url),
    error=>error instanceof BrowserWorkerFixtureAccessError,url);
};

test('allow regular fixture files with MIME, byte reads and HEAD',async()=>{
  await withSandbox(async root=>{
    const a=await resolveBrowserWorkerFixture(root,'/src/compiler.mjs');
    assert.equal(a.path,join(root,'src','compiler.mjs'));
    assert.equal(a.contentType,'text/javascript; charset=utf-8');
    const b=await readBrowserWorkerFixture(root,'/tests/fixtures/worker.ores?cache=off');
    assert.match(b.body.toString('utf8'),/pub fnc/);
    assert.equal(b.contentType,'text/plain; charset=utf-8');
    const c=await readBrowserWorkerFixture(root,'/tests/worker.html',{head:true});
    assert.equal(c.contentType,'text/html; charset=utf-8');
    assert.equal(c.body,undefined);
  });
});

test('deny traversal, hidden, symlink escapes, in-root aliases and directories',async()=>{
  await withSandbox(async root=>{
    for(const url of [
      '/secret.mjs','/.github/workflows/secrets.mjs','/src/../secret.mjs',
      '/src/../tests/worker.html','/src/%2e%2e/tests/worker.html',
      '//untrusted/src/compiler.mjs','/src/%2e%2e/secret.mjs',
      '/src/../../.github/workflows/secrets.mjs','/tests/.hidden.mjs',
      '/tests/fixtures/wrong.json','/src/escaped.mjs',
      '/src/hidden-alias.mjs','/src/allowed.html',
      '/src/alias/worker.ores','/src/directory.mjs',
      '/src/not-there.mjs/../escaped.mjs','/src/%5c..%5csecret.mjs'
    ]) await denied(root,url);
  });
});

test('bounded and malformed file or path requests fail closed',async()=>{
  await withSandbox(async root=>{
    await denied(root,'/src/'+'x'.repeat(4100)+'.mjs');
    await assert.rejects(resolveBrowserWorkerFixture(root,'/src/%ZZ.mjs'),/URI malformed/);
    await assert.rejects(readBrowserWorkerFixture(root,'/tests/fixtures/oversized.mjs'),
      error=>error instanceof BrowserWorkerFixtureAccessError);
    await assert.rejects(readBrowserWorkerFixture(root,'/src/escaped.mjs'),
      error=>error instanceof BrowserWorkerFixtureAccessError);
  });
});
