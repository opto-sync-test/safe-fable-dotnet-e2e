import {copyOwnedValue,copyOwnedValueWithBytes} from './worker-actor-copy.mjs';
// Trusted host adapter, NOT source-level actor lowering or a sandbox.
// Exactly one guest handler executes per Worker. A fatal protocol violation
// revokes the session and suppresses late replies; it does not preempt code.
const PROTOCOL='ores.js.worker.v1';
const MAX_CONFIGURED_PENDING_BYTES=256*1024*1024;
const errorText=e=>{
  try{return String(e?.message ?? e).slice(0,512);}
  catch{return 'uninspectable actor failure';}
};

export function installWorkerActorEndpoint({subscribe,post}) {
  if(typeof subscribe!=='function'||typeof post!=='function')
    throw new TypeError('invalid actor endpoint transport');
  let initializing=false,initialized=false,terminal=false,receive=null;
  let processing=false,inFlight=0,inFlightBytes=0,lastId=0,maxPending=0,maxPendingBytes=0;
  const queue=[];
  const reply=frame=>post({protocol:PROTOCOL,...frame});
  function fail(reason){
    if(terminal)return;
    terminal=true;
    // Release queued reservations immediately. The current executing turn
    // retains its loan until its finally block runs (no forced preemption).
    for(const item of queue){inFlight--;inFlightBytes-=item.bytes;}
    queue.length=0;
    try{reply({kind:'fatal',error:reason});}catch{/* transport already lost */}
  }
  async function drain(){
    if(processing||!receive||terminal)return;
    processing=true;
    try{
      while(!terminal&&queue.length){
        const frame=queue.shift();
        let completed=false,claimed=false,response;
        const self=Object.freeze({
          respond(value){
            if(terminal||completed||claimed||!frame.reply)
              throw new Error('reply unavailable or already claimed');
            response=copyOwnedValue(value);
            claimed=true;
          },
          done(){
            if(terminal||completed)throw new Error('delivery already completed');
            completed=true;
          }
        });
        try{
          await receive(frame.value,self);
          if(terminal)break;
          if(!completed)throw new Error('actor handler must call self.done()');
          if(frame.reply&&!claimed)
            throw new Error('request completed without self.respond()');
          reply({kind:'result',id:frame.id,ok:true,
            value:frame.reply?response:null});
        }catch(error){
          if(!terminal){
            try{reply({kind:'result',id:frame.id,ok:false,error:errorText(error)});}
            catch{fail('actor result transport failure');}
          }
        }finally{
          completed=true;
          inFlight--;
          inFlightBytes-=frame.bytes;
        }
      }
    }finally{processing=false;}
  }
  subscribe(frame=>{
    try {
    if(terminal)return;
    if(!frame||typeof frame!=='object'||frame.protocol!==PROTOCOL||
       !['init','deliver'].includes(frame.kind)){
      fail('invalid actor frame');return;
    }
    if(frame.kind==='init'){
      if(initializing||initialized){fail('duplicate initialization');return;}
      initializing=true;
      if(typeof frame.moduleUrl!=='string'||!frame.moduleUrl||
         typeof frame.exportName!=='string'||
         !/^[A-Za-z_][A-Za-z0-9_]*$/.test(frame.exportName)||
         !['handler','call'].includes(frame.mode)||
         !Number.isSafeInteger(frame.maxPending)||
         frame.maxPending<1||frame.maxPending>65536||
         !Number.isSafeInteger(frame.maxPendingBytes)||
         frame.maxPendingBytes<1||
         frame.maxPendingBytes>MAX_CONFIGURED_PENDING_BYTES){
        fail('invalid actor module descriptor');return;
      }
      maxPending=frame.maxPending;
      maxPendingBytes=frame.maxPendingBytes;
      void (async()=>{
        try{
          const module=await import(frame.moduleUrl);
          if(terminal)return;
          const fn=Object.getOwnPropertyDescriptor(module,frame.exportName)?.value;
          if(typeof fn!=='function')throw new Error('actor entrypoint not found');
          receive=frame.mode==='handler'?fn:(mail,self)=>{
            if(!mail||!Array.isArray(mail.args)||mail.args.length>128)
              throw new Error('invalid call arguments');
            const result=fn(...mail.args);
            if(result&&typeof result.then==='function')
              throw new Error('async function ABI unsupported');
            self.respond(result);
            self.done();
          };
          if(terminal)return;
          initialized=true;
          reply({kind:'ready'});
        }catch(error){fail(errorText(error));}
      })();
      return;
    }
    if(!initialized||!Number.isSafeInteger(frame.id)||frame.id<=lastId||
       typeof frame.reply!=='boolean'){
      fail('invalid or premature delivery');return;
    }
    // Includes the one currently executing turn, not only the queued frames.
    if(inFlight>=maxPending){fail('actor mailbox capacity exceeded');return;}
    let snapshot,bytes;
    try{({value:snapshot,bytes}=copyOwnedValueWithBytes(frame.value));}
    catch{fail('invalid actor delivery payload');return;}
    if(bytes>maxPendingBytes-inFlightBytes){
      fail('actor mailbox byte capacity exceeded');return;
    }
    lastId=frame.id;
    inFlight++;
    inFlightBytes+=bytes;
    queue.push({id:frame.id,reply:frame.reply,value:snapshot,bytes});
    void drain();
    } catch {fail('invalid actor frame');}
  });
}
