// A restricted copy-only value profile for the trusted Worker host adapter.
// This is NOT a sandbox for executing adversarial JS and bytes are estimated
// content size, not heap usage, wire size, or an allocation-free preflight.
const MAX_NODES=8192, MAX_DEPTH=64, MAX_CONTENT_BYTES=8*1024*1024;
const MISSING=Symbol('no internal slot');
const ownKeys=Reflect.ownKeys, descriptor=Object.getOwnPropertyDescriptor;
const getPrototype=Object.getPrototypeOf;
const nativeTag=Object.prototype.toString;
const arrayBufferBytes=descriptor(ArrayBuffer.prototype,'byteLength').get;
// A resizable ArrayBuffer can have zero currently allocated bytes but retain a
// much larger cloneable growth capacity. Budget the maximum, not just length.
const arrayBufferCapacity=descriptor(ArrayBuffer.prototype,'maxByteLength')?.get;
const sharedBytes=typeof SharedArrayBuffer==='function'?
  descriptor(SharedArrayBuffer.prototype,'byteLength').get:null;
const typedBuffer=descriptor(getPrototype(Uint8Array.prototype),'buffer').get;
const viewBuffer=descriptor(DataView.prototype,'buffer').get;
const blobBytes=typeof Blob==='function'?descriptor(Blob.prototype,'size').get:null;
const blobType=typeof Blob==='function'?descriptor(Blob.prototype,'type').get:null;
const mapSize=descriptor(Map.prototype,'size').get, setSize=descriptor(Set.prototype,'size').get;
const mapEntries=Map.prototype.entries, setValues=Set.prototype.values;
const regexpSource=descriptor(RegExp.prototype,'source').get;
const dateTime=Date.prototype.getTime;
const stringValue=String.prototype.valueOf;
const numberValue=Number.prototype.valueOf, booleanValue=Boolean.prototype.valueOf;
const bigintHex=BigInt.prototype.toString;
// An optional File has extra cloneable name/metadata not measured as Blob data.
const fileName=typeof File==='function'?
  descriptor(File.prototype,'name')?.get:null;
function slot(reader,node){
  if(!reader)return MISSING;
  try{return reader.call(node);}catch(e){if(e instanceof TypeError)return MISSING;throw e;}
}
function bigintSize(value){
  const hex=bigintHex.call(value,16);
  return Math.ceil((hex.length-(hex[0]==='-'?1:0))/2);
}
function validate(value){
  const visited=new WeakSet();
  let nodes=0,entries=0,bytes=0;
  function charge(n){
    if(!Number.isSafeInteger(n)||n<0||n>MAX_CONTENT_BYTES-bytes)
      throw new RangeError('actor message byte budget exceeded');
    bytes+=n;
  }
  function own(node,depth){
    for(const key of ownKeys(node)){
      if(++entries>MAX_NODES)throw new RangeError('actor message complexity exceeded');
      if(typeof key==='symbol')
        throw new TypeError('unsupported actor wire symbol key');
      charge(key.length*2);
      const d=descriptor(node,key);
      if(!d||!Object.hasOwn(d,'value'))
        throw new TypeError('actor message accessors forbidden in copy-only profile');
      walk(d.value,depth+1);
    }
  }
  function walk(node,depth){
    if(typeof node==='string'){charge(node.length*2);return;}
    if(typeof node==='bigint'){charge(bigintSize(node));return;}
    if(node===null||typeof node==='undefined'||typeof node==='boolean'||typeof node==='number')return;
    if(typeof node!=='object')throw new TypeError('unsupported actor wire value');
    if(depth>MAX_DEPTH)throw new RangeError('actor message complexity exceeded');
    if(visited.has(node))return;
    visited.add(node);
    if(++nodes>MAX_NODES)throw new RangeError('actor message complexity exceeded');
    if(slot(sharedBytes,node)!==MISSING)
      throw new TypeError('shared-memory actor message forbidden in copy-only profile');
    const raw=slot(arrayBufferBytes,node);
    if(raw!==MISSING){
      const capacity=slot(arrayBufferCapacity,node);
      charge(capacity===MISSING?raw:Math.max(raw,capacity));return;
    }
    if(ArrayBuffer.isView(node)){
      const viewed=slot(viewBuffer,node);
      const backing=viewed!==MISSING?viewed:slot(typedBuffer,node);
      if(backing===MISSING)throw new TypeError('unsupported actor wire value');
      walk(backing,depth+1);return;
    }
    const file=slot(fileName,node);
    if(file!==MISSING)throw new TypeError('unsupported actor wire File');
    const blob=slot(blobBytes,node);
    if(blob!==MISSING){
      // Structured cloning preserves both byte payload and the MIME type.
      // A zero-byte Blob can carry an arbitrarily long type string. Never
      // trust an overridden instance .type property when budgeting it.
      const type=slot(blobType,node);
      if(typeof type!=='string')throw new TypeError('unsupported actor wire Blob type');
      charge(blob);charge(type.length*2);return;
    }
    const pattern=slot(regexpSource,node);
    if(pattern!==MISSING){charge(pattern.length*2);own(node,depth);return;}
    const time=slot(dateTime,node);
    if(time!==MISSING){charge(8);own(node,depth);return;}
    const str=slot(stringValue,node);
    if(str!==MISSING){charge(str.length*2);own(node,depth);return;}
    const bn=slot(function(){return bigintHex.call(this,16);},node);
    if(bn!==MISSING){charge(Math.ceil((bn.length-(bn[0]==='-'?1:0))/2));own(node,depth);return;}
    const num=slot(numberValue,node);
    if(num!==MISSING){charge(8);own(node,depth);return;}
    const bool=slot(booleanValue,node);
    if(bool!==MISSING){charge(1);own(node,depth);return;}
    if(slot(mapSize,node)!==MISSING){
      for(const [k,v] of mapEntries.call(node)){
        if(++entries>MAX_NODES)throw new RangeError('actor message complexity exceeded');
        walk(k,depth+1);walk(v,depth+1);
      }
      return;
    }
    if(slot(setSize,node)!==MISSING){
      for(const item of setValues.call(node)){
        if(++entries>MAX_NODES)throw new RangeError('actor message complexity exceeded');
        walk(item,depth+1);
      }
      return;
    }
    if(Array.isArray(node)){
      // Sparse arrays can request enormous clone-time backing storage with
      // few enumerable elements: the length needs its own admission bound.
      if(node.length>MAX_NODES)throw new RangeError('actor message complexity exceeded');
      own(node,depth);return;
    }
    const proto=getPrototype(node);
    // A native Error (or another exotic cloneable) can be disguised by
    // changing its prototype to Object.prototype. structuredClone still
    // copies its internal data. Reject anything not natively a record.
    // Object.prototype.toString consults Symbol.toStringTag. Reject any
    // instance override before asking for the native tag, or an accessor
    // there could execute arbitrary caller JS during validation.
    if(descriptor(node,Symbol.toStringTag))
      throw new TypeError('unsupported actor wire symbol key');
    // Inherited Symbol.toStringTag is consulted by Object#toString too.
    // An attacker can pollute Object.prototype to make a disguised native
    // Error claim '[object Object]' without changing cloneable internal slots.
    if(proto===Object.prototype &&
       descriptor(Object.prototype,Symbol.toStringTag))
      throw new TypeError('unsupported actor wire inherited symbol tag');
    if((proto!==null&&proto!==Object.prototype)||
       nativeTag.call(node)!=='[object Object]')
      throw new TypeError('unsupported actor wire object type');
    own(node,depth);
  }
  walk(value,0);
  return bytes;
}
export function copyOwnedValueWithBytes(value){
  validate(value);
  const snapshot=structuredClone(value);
  const bytes=validate(snapshot);
  return Object.freeze({value:snapshot,bytes});
}
export function copyOwnedValue(value){return copyOwnedValueWithBytes(value).value;}
