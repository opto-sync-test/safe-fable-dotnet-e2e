import {copyOwnedValue,copyOwnedValueWithBytes} from './worker-actor-copy.mjs';
const PROTOCOL = 'ores.js.worker.v1';
// An Error message is not necessarily stringifiable (e.g. null-prototype
// structured-clone records). Never allow logging to interrupt settlement.
const errorText = error => {
  try {return String(error?.message ?? error).slice(0,512);}
  catch {return 'uninspectable actor failure';}
};
const DEFAULT_MAX_PENDING_BYTES=32*1024*1024;
const MAX_CONFIGURED_PENDING_BYTES=256*1024*1024;
const UNSUPPORTED_PLACEMENT_KEYS = Object.freeze([
  'placement','cpuAffinity','maxParallelTurns',
  'accelerator','gpuDeviceId','maxGpuInFlight'
]);

export function rejectUnsupportedWorkerPlacement(options) {
  if (!options || typeof options !== 'object')
    throw new TypeError('worker actor options must be an object');
  for (const key of UNSUPPORTED_PLACEMENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(options,key)) {
      throw new TypeError(
        'JavaScript Worker backend cannot guarantee CPU/GPU placement: ' + key);
    }
  }
}
export function createWorkerActorClient({worker, moduleUrl, exportName = 'receive', mode = 'handler', maxPending = 64,
  maxPendingBytes = DEFAULT_MAX_PENDING_BYTES}) {
  if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function')
    throw new TypeError('invalid Worker');
  if (typeof moduleUrl !== 'string' || !moduleUrl || typeof exportName !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(exportName) || !['handler','call'].includes(mode))
    throw new TypeError('invalid entrypoint');
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 65536)
    throw new RangeError('invalid mailbox limit');
  if(!Number.isSafeInteger(maxPendingBytes)||maxPendingBytes<1||
     maxPendingBytes>MAX_CONFIGURED_PENDING_BYTES)
    throw new RangeError('invalid actor mailbox byte limit');
  const pending = new Map();
  let pendingBytes=0;
  let nextId = 1, closed = false, ready = false;
  let readyResolve, readyReject;
  const readyPromise = new Promise((resolve,reject) => {readyResolve = resolve; readyReject = reject;});
  void readyPromise.catch(() => {}); // callers can await actor.ready explicitly
  function shutdown(error) {
    if (closed) return;
    closed = true;
    if (!ready) readyReject(error);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    pendingBytes=0;
  }
  function release(id){
    const entry=pending.get(id);
    if(!entry)return;
    pending.delete(id);
    pendingBytes-=entry.bytes;
  }
  // Worker frames are from the trusted adapter, but malformed/unexpected
  // control frames must still revoke outstanding receipts, never hang them.
  function failProtocol(message) {
    shutdown(new Error(message));
    void worker.terminate();
  }
  function onFrame(frame) {
    if (closed) return;
    if (!frame || typeof frame !== 'object' || frame.protocol !== PROTOCOL ||
        !['ready','fatal','result'].includes(frame.kind)) {
      failProtocol('invalid actor frame');return;
    }
    if (frame.kind === 'ready') {
      if (ready) {shutdown(new Error('duplicate actor ready'));void worker.terminate();return;}
      ready = true; readyResolve();
    } else if (frame.kind === 'fatal') {
      shutdown(new Error('actor startup/protocol failure: ' + errorText(frame.error)));
      void worker.terminate();
    } else if (frame.kind === 'result') {
      if (!ready) {failProtocol('actor result before ready');return;}
      // Control properties may be accessors in custom Worker transports.
      // Match and release the very same receipt, even if an id getter changes.
      const id=frame.id;
      const entry = pending.get(id);
      if (!entry) {shutdown(new Error('unexpected actor response id'));void worker.terminate();return;}
      if (frame.ok === true) {
        // A Worker response is a new ownership boundary. Even trusted adapter
        // code can regress and return a SharedArrayBuffer, or a test Worker
        // can forge a success frame. Never expose such aliases to callers.
        let snapshot;
        try {snapshot = entry.reply ? copyOwnedValue(frame.value) : undefined;}
        catch {
          failProtocol('invalid actor response payload');
          return;
        }
        release(id);
        entry.resolve(snapshot);
      } else if (frame.ok === false) {
        // Parse the negative result before revoking its receipt. An accessor-
        // throwing frame.error must fail the whole protocol and reject every
        // outstanding promise, including this one. Releasing first would
        // orphan the promise because shutdown no longer finds its entry.
        const reason=errorText(frame.error);
        release(id);
        entry.reject(new Error('actor delivery failed: '+reason));
      } else {
        failProtocol('invalid actor response');
      }
    }
  }
  // A custom Worker adapter or test transport may deliver accessor-backed
  // frames rather than structured-cloned records. An event callback must
  // never throw before revoking outstanding message reservations.
  function guardedOnFrame(frame) {
    try {onFrame(frame);} catch {failProtocol('invalid actor frame');}
  }
  if (typeof worker.addEventListener === 'function') {
    worker.addEventListener('message', e => {
      try {guardedOnFrame(e.data);} catch {failProtocol('invalid actor frame');}
    });
    worker.addEventListener('error', () => {
      shutdown(new Error('worker execution failure'));void worker.terminate();
    });
    worker.addEventListener('messageerror', () => {
      shutdown(new Error('worker message decoding failure'));void worker.terminate();
    });
  } else if (typeof worker.on === 'function') {
    worker.on('message', guardedOnFrame);
    worker.on('error', err => {
      shutdown(new Error('worker execution failure: ' + errorText(err)));
      void worker.terminate();
    });
    worker.on('messageerror', () => {
      shutdown(new Error('worker message decoding failure'));void worker.terminate();
    });
    worker.on('exit', code => shutdown(new Error('worker exited: ' + code)));
  } else throw new TypeError('Worker event interface unsupported');
  try {worker.postMessage({protocol: PROTOCOL,kind:'init',moduleUrl,exportName,mode,maxPending,maxPendingBytes});}
  catch (error) {shutdown(error);void worker.terminate();}
  function send(value, reply) {
    if (closed) return Promise.reject(new Error('actor closed'));
    if (pending.size >= maxPending) return Promise.reject(new Error('actor mailbox capacity exceeded'));
    if (!Number.isSafeInteger(nextId)) return Promise.reject(new Error('actor message id exhausted'));
    // Take ownership at admission, not after the Worker startup handshake.
    // This prevents callers from mutating an outstanding queued delivery.
    let snapshot,bytes;
    try {
      ({value:snapshot,bytes}=copyOwnedValueWithBytes(value));
    } catch (error) {return Promise.reject(error);}
    if(bytes>maxPendingBytes-pendingBytes)
      return Promise.reject(new Error('actor mailbox byte capacity exceeded'));
    const id = nextId++;
    pendingBytes+=bytes;
    return new Promise((resolve,reject) => {
      pending.set(id,{resolve,reject,reply,bytes});
      void readyPromise.then(() => {
        if (!pending.has(id) || closed) return;
        try {worker.postMessage({protocol:PROTOCOL,kind:'deliver',id,reply,value:snapshot});}
        catch (error) {release(id);reject(error);}
      },reject);
    });
  }
  return Object.freeze({
    get ready() {return readyPromise;},
    get pending() {return pending.size;},
    get pendingBytes() {return pendingBytes;},
    request(value) {return send(value,true);},
    tell(value) {return send(value,false);},
    async close() {shutdown(new Error('actor closed'));await worker.terminate();}
  });
}
