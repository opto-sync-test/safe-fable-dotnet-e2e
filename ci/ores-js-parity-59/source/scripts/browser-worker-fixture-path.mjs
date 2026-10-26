// Local-only Chrome smoke fixture admission. Never use in production.
// The checkout and parent directories must not be concurrently writable by
// adversaries; Node lacks portable openat(O_NOFOLLOW) per parent component.
import {realpath,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,extname,sep} from 'node:path';

const MIME=Object.freeze({
  '.html':'text/html; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8',
  '.ores':'text/plain; charset=utf-8'
});
const MAX_FIXTURE_BYTES=1048576;
export class BrowserWorkerFixtureAccessError extends Error {
  constructor() {
    super('browser worker fixture path denied');
    this.name='BrowserWorkerFixtureAccessError';
  }
}
const deny=()=>{throw new BrowserWorkerFixtureAccessError();};

export async function resolveBrowserWorkerFixture(root,requestUrl) {
  if(typeof root!=='string'||typeof requestUrl!=='string'||
     requestUrl.length>4096)deny();
  // Reject dot segments before URL canonicalization; no origin-form rewriting.
  const raw=requestUrl.split(/[?#]/,1)[0];
  if(!raw.startsWith('/')||raw.startsWith('//'))deny();
  const decoded=decodeURIComponent(raw);
  if(decoded.includes('\\')||decoded.includes('\0')||
     decoded.split('/').some(part=>part==='.'||part==='..'))deny();
  const pathname=decodeURIComponent(new URL(requestUrl,'http://localhost').pathname);
  if(!/^\/(?:src\/|tests\/)/.test(pathname)||pathname.includes('\\')||
     pathname.split('/').some(part=>part.startsWith('.')))deny();
  const directory=await realpath(root);
  const allow=[resolve(directory,'src')+sep,resolve(directory,'tests')+sep];
  const file=resolve(directory,pathname.slice(1));
  if(!allow.some(prefix=>file.startsWith(prefix)))deny();
  const extension=extname(file);
  if(!Object.hasOwn(MIME,extension))deny();
  // Reject every path symlink, not just escapes: even an allowed internal
  // symlink can be retargeted between canonicalization and file opening.
  const parts=file.slice(directory.length+1).split(sep);
  let parent=directory;
  for(let i=0;i<parts.length;i++){
    parent=resolve(parent,parts[i]);
    const metadata=await lstat(parent);
    if(metadata.isSymbolicLink()||
       (i===parts.length-1?!metadata.isFile():!metadata.isDirectory()))deny();
  }
  const target=await realpath(file);
  if(target!==file || !allow.some(prefix=>target.startsWith(prefix)))deny();
  return Object.freeze({path:target,contentType:MIME[extension]});
}

export async function readBrowserWorkerFixture(root,requestUrl,{head=false}={}) {
  const fixture=await resolveBrowserWorkerFixture(root,requestUrl);
  // O_NOFOLLOW prevents final-component replacement by a symlink, while
  // O_NONBLOCK keeps a malicious FIFO from blocking the fixture process.
  const flags=constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0);
  const descriptor=await open(fixture.path,flags);
  try {
    const stat=await descriptor.stat();
    if(!stat.isFile()||!Number.isSafeInteger(stat.size)||
       stat.size>MAX_FIXTURE_BYTES)deny();
    // Before consuming bytes, recheck the final path and open-file identity.
    const currentPath=await realpath(fixture.path);
    const current=await lstat(fixture.path);
    if(currentPath!==fixture.path || current.isSymbolicLink() ||
       !current.isFile() ||current.ino!==stat.ino||current.dev!==stat.dev)deny();
    const body=head?undefined:await descriptor.readFile();
    if(body&&body.byteLength>MAX_FIXTURE_BYTES)deny();
    return Object.freeze({contentType:fixture.contentType,body});
  }finally {await descriptor.close();}
}
