// No third-party dependencies; must execute a REAL browser module Worker.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readBrowserWorkerFixture,BrowserWorkerFixtureAccessError} from './browser-worker-fixture-path.mjs';
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const profile=await mkdtemp(join(tmpdir(),'ores-js-browser-'));
const server=createServer(async(req,res)=>{
  try {
    if(req.method!=='GET'&&req.method!=='HEAD'){
      res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;
    }
    const admitted=await readBrowserWorkerFixture(root,req.url,{head:req.method==='HEAD'});
    res.setHeader('Content-Type',admitted.contentType);
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'unsafe-inline' blob:; connect-src 'self'; worker-src 'self' blob:; style-src 'none'; base-uri 'none'; object-src 'none'");
    res.end(admitted.body);
  }catch(error){
    res.writeHead(error instanceof BrowserWorkerFixtureAccessError?403:
      error?.code==='ENOENT'?404:400);
    res.end();
  }
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const chrome=spawn(process.env.CHROME_BIN||'google-chrome',[
  '--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run',
  '--disable-background-networking','--remote-debugging-port=0',
  '--user-data-dir='+profile,'about:blank'
],{stdio:['ignore','ignore','pipe']});
let chromeStderr='';
chrome.stderr.on('data',chunk=>{chromeStderr=(chromeStderr+chunk).slice(-16000);});
let exited=false,chromeError=null,ws;
chrome.on('exit',()=>{exited=true;});
chrome.on('error',err=>{chromeError=err;exited=true;});
try{
  let port;
  for(let i=0;i<600;i++){
    if(exited)throw Error('browser process exited: '+chromeError+' '+chromeStderr);
    try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break;}catch{}
    await delay(100);
  }
  if(!port)throw Error('browser DevTools startup timeout: '+chromeStderr);
  const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  const page=pages.find(p=>p.type==='page');
  if(!page)throw Error('browser target missing');
  ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok,fail)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',fail,{once:true});});
  const outstanding=new Map();let id=0;
  ws.addEventListener('message',event=>{
    const v=JSON.parse(event.data),p=outstanding.get(v.id);
    if(p){outstanding.delete(v.id);v.error?p.fail(Error(JSON.stringify(v.error))):p.ok(v.result);}
  });
  const rpc=(method,params={})=>new Promise((ok,fail)=>{
    const n=++id;outstanding.set(n,{ok,fail});ws.send(JSON.stringify({id:n,method,params}));
  });
  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/tests/browser-worker-smoke.html'});
  let status='';
  for(let i=0;i<180;i++){
    await delay(100);
    const answer=await rpc('Runtime.evaluate',{expression:"document.querySelector('#result')?.textContent",returnByValue:true});
    status=answer?.result?.value||'';
    if(status.startsWith('PASS_')||status.startsWith('FAIL_'))break;
  }
  console.log('Browser compile+module Worker: '+(status||'no result'));
  if(status!=='PASS_BROWSER_ESM_WORKER')throw Error('real browser smoke did not pass');
}finally{
  ws?.close();chrome.kill('SIGTERM');
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  // Chrome writes its temporary profile during shutdown; wait for its exit.
  if(!exited)await Promise.race([new Promise(r=>chrome.once('exit',r)),delay(1500)]);
  await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250}).catch(()=>{});
}
