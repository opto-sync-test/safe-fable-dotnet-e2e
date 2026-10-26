/**
 * Portable Symbol wire v1 host boundary.
 *
 * Wire identity is exactly {"$symbol":"process"|"stable","name":"..."}.
 * This module validates/copies wire data only; it does not manufacture a
 * compiler-artifact runtime brand. Generated artifacts rebrand only after this
 * same semantic admission contract has succeeded.
 */
const MAX_SOURCE_UNITS=1024;
const MAX_SYMBOL_BYTES=256;
const MAX_JSON_BYTES=2048;
const CORE_UNTRUSTED=new Set(['ready','error','Symbol.iterator']);
const CANONICAL_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SymbolWireV1Error extends Error {
  constructor(detail){super('error: Symbol wire v1: '+detail);this.name='SymbolWireV1Error';}
}
const fail=detail=>{throw new SymbolWireV1Error(detail);};

function utf8Length(value){return new TextEncoder().encode(value).length;}
function checkedName(value,{canonical=true,stable=false}={}){
  if(typeof value!=='string'||value.length>MAX_SOURCE_UNITS)
    fail('name exceeds pre-normalization budget');
  for(let i=0;i<value.length;i++){
    const unit=value.charCodeAt(i);
    if(unit>=0xd800&&unit<=0xdbff){
      const lo=value.charCodeAt(i+1);
      if(!(lo>=0xdc00&&lo<=0xdfff))fail('unpaired UTF-16 surrogate');
      i++;
    }else if(unit>=0xdc00&&unit<=0xdfff)fail('unpaired UTF-16 surrogate');
  }
  const normalized=value.normalize('NFC');
  if(canonical&&normalized!==value)fail('wire name must already be NFC');
  const result=canonical?value:normalized;
  const bytes=utf8Length(result);
  if(bytes<1||bytes>MAX_SYMBOL_BYTES)fail('name requires 1..256 UTF-8 bytes');
  for(const ch of result){
    const cp=ch.codePointAt(0);
    if(cp<0x20||(cp>=0x7f&&cp<=0x9f)||/[\p{Cf}\p{Zl}\p{Zp}]/u.test(ch)||
       cp===0x061c||cp===0x200e||cp===0x200f||
       (cp>=0x202a&&cp<=0x202e)||(cp>=0x2066&&cp<=0x2069))
      fail('control, line-separator, format, or bidi character in name');
  }
  if(stable&&!CANONICAL_UUID.test(result))
    fail('stable Symbol requires canonical lowercase UUID');
  return result;
}
function exactWireRecord(input){
  if(input===null||typeof input!=='object'||Array.isArray(input))
    fail('expected object');
  const proto=Object.getPrototypeOf(input);
  if(proto!==Object.prototype&&proto!==null)fail('non-plain object');
  const keys=Reflect.ownKeys(input);
  if(keys.length!==2||!keys.includes('$symbol')||!keys.includes('name')||
     keys.some(key=>typeof key!=='string'))
    fail('expected exact $symbol/name fields');
  for(const key of ['$symbol','name']){
    const desc=Object.getOwnPropertyDescriptor(input,key);
    if(!desc||!Object.hasOwn(desc,'value')||!desc.enumerable)
      fail('non-enumerable, accessor, or missing '+key);
  }
  return input;
}
function copied(kind,name){
  const out=Object.create(null);
  Object.defineProperties(out,{
    '$symbol':{value:kind,enumerable:true},
    name:{value:name,enumerable:true}
  });
  return Object.freeze(out);
}
function policyName(options){
  if(options===undefined)return 'trusted';
  if(options===null||typeof options!=='object'||Array.isArray(options))
    fail('invalid options');
  const proto=Object.getPrototypeOf(options);
  if(proto!==Object.prototype&&proto!==null)fail('non-plain options');
  const keys=Reflect.ownKeys(options);
  if(keys.length>1||keys.some(k=>k!=='policy'))fail('unknown option');
  const desc=Object.getOwnPropertyDescriptor(options,'policy');
  if(desc&&(!Object.hasOwn(desc,'value')||!desc.enumerable))fail('accessor/non-enumerable option');
  const policy=desc?desc.value:'trusted';
  if(policy!=='trusted'&&policy!=='untrusted-core')fail('unknown policy');
  return policy;
}

export function validateSymbolWireV1(input,options){
  const policy=policyName(options);
  const value=exactWireRecord(input);
  const kind=value.$symbol;
  if(kind!=='process'&&kind!=='stable')fail('unknown Symbol kind');
  const name=checkedName(value.name,{canonical:true,stable:kind==='stable'});
  if(policy==='untrusted-core'&&(kind!=='process'||!CORE_UNTRUSTED.has(name)))
    fail('Symbol denied by untrusted-core policy');
  return copied(kind,name);
}

export function symbolWireEqualV1(left,right){
  const a=validateSymbolWireV1(left);
  const b=validateSymbolWireV1(right);
  return a.$symbol===b.$symbol&&a.name===b.name;
}

export function stringifySymbolWireV1(input,options){
  const value=validateSymbolWireV1(input,options);
  // Stable field order is part of this helper's deterministic text form.
  return '{"$symbol":'+JSON.stringify(value.$symbol)+',"name":'+JSON.stringify(value.name)+'}';
}

function skipWs(text,state){
  while(state.i<text.length&&/[\u0009\u000a\u000d\u0020]/.test(text[state.i]))state.i++;
}
function readJsonString(text,state){
  if(text[state.i]!=='"')fail('expected JSON string');
  const start=state.i++;
  let escaped=false;
  while(state.i<text.length){
    const ch=text[state.i++];
    if(!escaped&&ch==='"'){
      const raw=text.slice(start,state.i);
      try{return JSON.parse(raw);}catch{fail('invalid JSON string');}
    }
    if(!escaped&&ch==='\\'){escaped=true;continue;}
    if(!escaped&&ch.charCodeAt(0)<0x20)fail('raw control in JSON string');
    escaped=false;
  }
  fail('unterminated JSON string');
}
export function parseSymbolWireJsonV1(text,options){
  if(typeof text!=='string'||utf8Length(text)>MAX_JSON_BYTES)
    fail('invalid or oversized JSON text');
  const state={i:0};
  skipWs(text,state);
  if(text[state.i++]!=='{')fail('expected JSON object');
  const seen=new Set(),fields=Object.create(null);
  skipWs(text,state);
  if(text[state.i]==='}')fail('empty object');
  while(true){
    const key=readJsonString(text,state);
    if(seen.has(key))fail('duplicate JSON member '+key);
    seen.add(key);
    skipWs(text,state);
    if(text[state.i++]!==':')fail('expected colon');
    skipWs(text,state);
    fields[key]=readJsonString(text,state);
    skipWs(text,state);
    if(text[state.i]===','){state.i++;skipWs(text,state);continue;}
    if(text[state.i]==='}'){state.i++;break;}
    fail('expected comma or object end');
  }
  skipWs(text,state);
  if(state.i!==text.length)fail('trailing JSON data');
  return validateSymbolWireV1(fields,options);
}
