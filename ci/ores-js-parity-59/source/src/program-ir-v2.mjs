/**
 * Strict JSON-safe resolved IR contract for the experimental program-v2 backend.
 * This is a backend-local migration seam, NOT yet the shared canonical Oreslang IR.
 */
export const PROGRAM_IR_VERSION=2;
export const PROGRAM_IR_DIALECT='oreslang.program';
export const PROGRAM_IR_INT_MODEL='signed-i64-checked-provisional';
const ID=/^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DEC=/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const MIN=-(1n<<63n), MAX=(1n<<63n)-1n;
const LIMIT_NODES=30000,LIMIT_DEPTH=192;
const CLASS_RESERVED=new Set([
  'default','new','class','export','import','null','true','false','this','super',
  'extends','static','constructor','prototype','__proto__','define','pub','as',
  'end','self','int','void','return','mut','private','actor','fnc','routine',
  'bool','Symbol','let','val','const','if','fi','then','else','await','task',
  'spawn','module','trait','interface','type','rt'
]);
const METHOD_CALLABLE_KEYWORDS=new Set([
  'mtd','method','stop','do','done','loop','block','select','readch','writech',
  'nb','true','false'
]);
export class ProgramIRError extends Error {
  constructor(detail) {super('error: program IR: '+detail);this.name='ProgramIRError';}
}
const fail=s=>{throw new ProgramIRError(s);};
function record(v,keys,context) {
  if(v===null || typeof v!=='object' || Array.isArray(v))fail(context+': expected object');
  const proto=Object.getPrototypeOf(v);
  if(proto!==null && proto!==Object.prototype)fail(context+': non-plain object');
  const own=Reflect.ownKeys(v);
  if(own.length!==keys.length || own.some(k=>typeof k!=='string'||!keys.includes(k)))
    fail(context+': missing/extra fields');
  for(const key of keys){
    const desc=Object.getOwnPropertyDescriptor(v,key);
    if(!desc || !Object.hasOwn(desc,'value'))fail(context+': accessor/missing '+key);
  }
  return v;
}
function sequence(v,max,context){
  if(!Array.isArray(v)||Object.getPrototypeOf(v)!==Array.prototype||v.length>max)
    fail(context+': invalid array');
  const own=Reflect.ownKeys(v);
  if(own.length!==v.length+1 || own.some(k=>k!=='length'&&(!/^(?:0|[1-9][0-9]*)$/.test(k)||Number(k)>=v.length)))
    fail(context+': unexpected array properties');
  for(let i=0;i<v.length;i++) {
    const desc=Object.getOwnPropertyDescriptor(v,i);
    if(!desc||!Object.hasOwn(desc,'value'))fail(context+': accessor/sparse array');
  }
  return v;
}
function ident(s,where) {
  if(typeof s!=='string'||!ID.test(s))fail(where+': invalid identifier');
  return s;
}
function classIdent(s,where){
  ident(s,where);
  if((CLASS_RESERVED.has(s)&&s!=='mtd'&&s!=='method')||
     s==='Option'||s==='Result')fail(where+': reserved identifier');
  return s;
}
function callableIdent(s,where){
  ident(s,where);
  if(CLASS_RESERVED.has(s)&&!METHOD_CALLABLE_KEYWORDS.has(s))
    fail(where+': reserved callable name');
  return s;
}
function int(s){
  if(typeof s!=='string'||s.length>20||!DEC.test(s))fail('invalid canonical integer');
  const n=BigInt(s);
  if(n<MIN||n>MAX)fail('integer outside provisional signed i64');
  return s;
}
function symbolName(s){
  if(typeof s!=='string'||s.length>1024)fail('Symbol source name exceeds normalization budget');
  for(let i=0;i<s.length;i++){
    const unit=s.charCodeAt(i);
    if(unit>=0xd800&&unit<=0xdbff){
      const lo=s.charCodeAt(i+1);
      if(!(lo>=0xdc00&&lo<=0xdfff))fail('unpaired UTF-16 surrogate in Symbol');
      i++;
    }else if(unit>=0xdc00&&unit<=0xdfff)fail('unpaired UTF-16 surrogate in Symbol');
  }
  const normalized=s.normalize('NFC');
  if(normalized!==s)fail('non-canonical NFC Symbol name');
  const bytes=new TextEncoder().encode(s).length;
  if(bytes<1||bytes>256)fail('Symbol name requires 1..256 UTF-8 bytes');
  for(const ch of s){
    const cp=ch.codePointAt(0);
    if(cp<0x20||(cp>=0x7f&&cp<=0x9f)||/[\p{Cf}\p{Zl}\p{Zp}]/u.test(ch)||
       cp===0x061c||cp===0x200e||cp===0x200f||
       (cp>=0x202a&&cp<=0x202e)||(cp>=0x2066&&cp<=0x2069))
      fail('control, line-separator, or bidi character in Symbol');
  }
  return s;
}
/**
 * Copy after validation, never return caller-owned IR references.
 * Direct object inputs are trusted data only, not a JavaScript sandbox.
 */
export function validateProgramIRV2(input) {
  if(input===null||typeof input!=='object'||Array.isArray(input))
    fail('program: expected object');
  const rawKeys=Reflect.ownKeys(input);
  const hasClasses=rawKeys.includes('classes');
  record(input,hasClasses?
    ['schemaVersion','dialect','integerModel','sourceNamespace','modules','functions','classes']:
    ['schemaVersion','dialect','integerModel','sourceNamespace','modules','functions'],'program');
  if(input.schemaVersion!==PROGRAM_IR_VERSION||input.dialect!==PROGRAM_IR_DIALECT||
     input.integerModel!==PROGRAM_IR_INT_MODEL)fail('unsupported IR version/dialect/model');
  const namespace=input.sourceNamespace===null?null:ident(input.sourceNamespace,'file namespace');
  const seenModules=new Set(),moduleNames=sequence(input.modules,512,'modules').map(m=>{
    const name=ident(m,'module name');
    if(seenModules.has(name))fail('duplicate module '+name);
    seenModules.add(name);
    return name;
  });
  const sourceFunctions=sequence(input.functions,512,'functions');
  const sourceClasses=hasClasses?sequence(input.classes,512,'classes'):[];
  if(hasClasses&&!sourceClasses.length)fail('redundant empty classes field');
  if(!moduleNames.length&&!sourceFunctions.length&&!sourceClasses.length)fail('empty program');
  const classNames=new Set(),classHeaders=sourceClasses.map(cls=>{
    record(cls,['name','pub','methods'],'class');
    const name=classIdent(cls.name,'class name');
    if(classNames.has(name)||seenModules.has(name))fail('duplicate class/module '+name);
    classNames.add(name);
    if(typeof cls.pub!=='boolean')fail('invalid class visibility');
    const slots=new Set(),methods=sequence(cls.methods,256,'class methods').map(method=>{
      record(method,['name','pub','params','paramTypes','returnType','body'],'class method');
      const methodName=callableIdent(method.name,'method name');
      if(typeof method.pub!=='boolean')fail('invalid method visibility');
      const params=sequence(method.params,32,'method parameters').map(p=>classIdent(p,'method parameter'));
      if(new Set(params).size!==params.length||params.includes('self'))
        fail('duplicate/reserved method parameter');
      const types=['int','bool','symbol','option<int>','result<int,int>'];
      const paramTypes=sequence(method.paramTypes,32,'method paramTypes');
      if(paramTypes.length!==params.length||paramTypes.some(t=>!types.includes(t)))
        fail('unsupported method parameter type');
      const returnType=method.returnType;
      if(returnType!=='void'&&!types.includes(returnType))fail('unsupported method return type');
      if(returnType==='void'&&method.body!==null)fail('void method body must be null');
      if(returnType!=='void'&&(method.body===null||typeof method.body!=='object'))
        fail('value method body required');
      const slot=methodName+'/'+params.length;
      if(slots.has(slot))fail('duplicate caller-visible method arity '+name+'.'+slot);
      slots.add(slot);
      return {name:methodName,pub:method.pub,params:[...params],
        paramTypes:[...paramTypes],returnType,body:method.body};
    });
    return {name,pub:cls.pub,methods};
  });
  const slots=new Set(),symbolKinds=new Map(),exportNames=new Set(moduleNames);
  const headers=sourceFunctions.map(f=>{
    // Reject nulls and non-records before any optional-key introspection.
    // The full record(...) admission below checks plain prototypes and every
    // exact own-data field before reading function metadata.
    if(f===null||typeof f!=='object'||Array.isArray(f))
      fail('function: expected plain data object');
    const keys=Reflect.ownKeys(f);
    const typed=keys.includes('paramTypes')||keys.includes('returnType');
    record(f,typed?['module','name','kind','pub','params','body','paramTypes','returnType']:
      ['module','name','kind','pub','params','body'],'function');
    const module=f.module===null?null:ident(f.module,'owner module');
    if(module!==null && !seenModules.has(module))fail('missing owner module '+module);
    const name=ident(f.name,'function name');
    if(f.kind!=='fnc'&&f.kind!=='routine')fail('unknown function kind');
    if(typeof f.pub!=='boolean')fail('invalid visibility');
    if(f.kind==='routine'&&f.pub)fail('public routine cannot be exported');
    const params=sequence(f.params,128,'parameters').map(p=>ident(p,'parameter'));
    if(new Set(params).size!==params.length)fail('duplicate parameters');
    const paramTypes=typed?sequence(f.paramTypes,128,'paramTypes'):params.map(()=>'int');
    const types=['int','bool','symbol','option<int>','result<int,int>'];
    if(paramTypes.length!==params.length||
       paramTypes.some(t=>!types.includes(t)))fail('unsupported function parameter type');
    const returnType=typed?f.returnType:'int';
    if(!types.includes(returnType))fail('unsupported function return type');
    if(typed&&returnType==='int'&&paramTypes.every(t=>t==='int'))
      fail('redundant typed metadata on int-only function');
    const slot=(module===null?'@file/':'@module/'+module+'/')+name+'/'+params.length;
    if(slots.has(slot))fail('duplicate caller-visible method arity '+slot);
    const family=slot.slice(0,slot.lastIndexOf('/'));
    if(symbolKinds.has(family)&&symbolKinds.get(family)!==f.kind)
      fail('fnc/routine overload kind conflict '+family);
    symbolKinds.set(family,f.kind);
    slots.add(slot);
    if(module===null&&f.pub)exportNames.add(name);
    return {module,name,kind:f.kind,pub:f.pub,params,
      ...(typed?{paramTypes:[...paramTypes],returnType}: {})};
  });
  // Export-name collisions are legal only for overloads of the same root
  // function, and NEVER between a runtime module object and a root function.
  for(const header of headers)if(header.module===null&&header.pub&&seenModules.has(header.name))
    fail('file export conflicts with runtime module '+header.name);
  for(const cls of classHeaders){
    if(cls.pub&&seenModules.has(cls.name))fail('class export conflicts with runtime module '+cls.name);
    if(cls.pub&&headers.some(h=>h.module===null&&h.pub&&h.name===cls.name))
      fail('class export conflicts with root function '+cls.name);
  }
  const graph=headers.map(()=>new Set());
  let nodes=0;
  const captureSlots=headers.map(()=>new Set());
  function node(expr,owner,depth=0,expected='int',active=[]){
    if(++nodes>LIMIT_NODES||depth>LIMIT_DEPTH)fail('expression complexity exceeded');
    if(!expr||typeof expr!=='object'||Array.isArray(expr))fail('invalid expression');
    const desc=Object.getOwnPropertyDescriptor(expr,'kind');
    if(!desc||!Object.hasOwn(desc,'value'))fail('invalid expression kind');
    // No implicit truthiness or numeric coercions, including in supplied IR.
    if(expected==='bool'&&['int','neg','binary'].includes(desc.value))
      fail('boolean expression required');
    if(expected!=='bool'&&['bool','compare','symbolCompare','not'].includes(desc.value))
      fail('boolean value cannot be used as non-bool');
    if(expected!=='int'&&['int','neg','binary'].includes(desc.value))
      fail('integer expression cannot be used as non-int');
    if(expected!=='symbol'&&desc.value==='symbol')
      fail('Symbol value cannot be used as non-Symbol');
    switch(desc.value) {
      case 'int':
        record(expr,['kind','value'],'int');
        if(expected!=='int')fail('boolean expected, got int');
        return {kind:'int',value:int(expr.value)};
      case 'bool':
        record(expr,['kind','value'],'bool');
        if(expected!=='bool'||typeof expr.value!=='boolean')fail('invalid bool literal/type');
        return {kind:'bool',value:expr.value};
      case 'symbol':
        record(expr,['kind','value'],'symbol');
        if(expected!=='symbol')fail('Symbol literal type mismatch');
        return {kind:'symbol',value:symbolName(expr.value)};
      case 'newClass': {
        record(expr,['kind','classIndex'],'class construction');
        if(!Number.isSafeInteger(expr.classIndex)||Object.is(expr.classIndex,-0)||
           expr.classIndex<0||expr.classIndex>=classHeaders.length)
          fail('invalid class construction target');
        if(expected!=='class:'+expr.classIndex)fail('class construction type mismatch');
        return {kind:'newClass',classIndex:expr.classIndex};
      }
      case 'methodCall':
      case 'namedMethodCall': {
        const named=desc.value==='namedMethodCall';
        record(expr,named?
          ['kind','classIndex','methodIndex','receiver','args','paramOrder']:
          ['kind','classIndex','methodIndex','receiver','args'],
          named?'named method call':'method call');
        if(!Number.isSafeInteger(expr.classIndex)||Object.is(expr.classIndex,-0)||
           expr.classIndex<0||expr.classIndex>=classHeaders.length)
          fail('invalid method class target');
        const cls=classHeaders[expr.classIndex];
        if(!Number.isSafeInteger(expr.methodIndex)||Object.is(expr.methodIndex,-0)||
           expr.methodIndex<0||expr.methodIndex>=cls.methods.length)
          fail('invalid method target');
        const method=cls.methods[expr.methodIndex];
        if(!method.pub)fail('private method cannot be called externally');
        if(method.returnType==='void')fail('void method cannot be used as expression');
        if(method.returnType!==expected)fail('method return type mismatch');
        const receiver=node(expr.receiver,owner,depth+1,'class:'+expr.classIndex,active);
        const args=sequence(expr.args,32,'method call args');
        let order=method.params.map((_,i)=>i);
        if(named){
          const supplied=sequence(expr.paramOrder,32,'method parameter order');
          if(supplied.length!==args.length||args.length!==method.params.length)
            fail('named method arity mismatch');
          const seen=new Set();
          order=supplied.map(slot=>{
            if(!Number.isSafeInteger(slot)||Object.is(slot,-0)||slot<0||
               slot>=method.params.length||seen.has(slot))
              fail('invalid named method parameter order');
            seen.add(slot);return slot;
          });
          if(seen.size!==method.params.length)fail('incomplete named method parameter order');
        }else if(args.length!==method.params.length)fail('method arity mismatch');
        return {
          kind:desc.value,classIndex:expr.classIndex,methodIndex:expr.methodIndex,
          receiver,args:args.map((arg,i)=>node(arg,owner,depth+1,method.paramTypes[order[i]],active)),
          ...(named?{paramOrder:order}:{})
        };
      }
      case 'capture':
        record(expr,['kind','slot'],'capture');
        if(!Number.isSafeInteger(expr.slot)||Object.is(expr.slot,-0)||expr.slot<0||
           !active.includes(expr.slot))
          fail('ADT capture outside its typed payload scope');
        if(expected!=='int')fail('ADT int payload capture type mismatch');
        return {kind:'capture',slot:expr.slot};
      case 'param':
        record(expr,['kind','index'],'param');
        if(!Number.isSafeInteger(expr.index)||Object.is(expr.index,-0)||expr.index<0||expr.index>=headers[owner].params.length)
          fail('out-of-bounds parameter');
        if((headers[owner].paramTypes?.[expr.index]??'int')!==expected)
          fail('parameter type mismatch');
        return {kind:'param',index:expr.index};
      case 'neg':
        record(expr,['kind','inner'],'neg');
        if(expected!=='int')fail('int negation in boolean context');
        return {kind:'neg',inner:node(expr.inner,owner,depth+1,'int',active)};
      case 'not':
        record(expr,['kind','inner'],'not');
        if(expected!=='bool')fail('boolean negation in integer context');
        return {kind:'not',inner:node(expr.inner,owner,depth+1,'bool',active)};
      case 'binary':
        record(expr,['kind','op','left','right'],'binary');
        if(expected!=='int')fail('arithmetic in boolean context');
        if(!['+','-','*','%'].includes(expr.op))fail('unsupported binary operator');
        return {kind:'binary',op:expr.op,
          left:node(expr.left,owner,depth+1,'int',active),right:node(expr.right,owner,depth+1,'int',active)};
      case 'compare':
        record(expr,['kind','op','left','right'],'compare');
        if(expected!=='bool')fail('comparison in integer context');
        if(!['<','>','<=','>=','==','!='].includes(expr.op))fail('unsupported comparator');
        return {kind:'compare',op:expr.op,left:node(expr.left,owner,depth+1,'int',active),
          right:node(expr.right,owner,depth+1,'int',active)};
      case 'symbolCompare':
        record(expr,['kind','op','left','right'],'Symbol compare');
        if(expected!=='bool')fail('Symbol comparison outside bool context');
        if(expr.op!=='=='&&expr.op!=='!=')fail('unsupported Symbol comparator');
        return {kind:'symbolCompare',op:expr.op,
          left:node(expr.left,owner,depth+1,'symbol',active),
          right:node(expr.right,owner,depth+1,'symbol',active)};
      case 'if':
        record(expr,['kind','condition','yes','no'],'if');
        return {kind:'if',condition:node(expr.condition,owner,depth+1,'bool',active),
          yes:node(expr.yes,owner,depth+1,expected,active),
          no:node(expr.no,owner,depth+1,expected,active)};
      case 'call': {
        record(expr,['kind','target','args'],'call');
        if(!Number.isSafeInteger(expr.target)||Object.is(expr.target,-0)||expr.target<0||expr.target>=headers.length)
          fail('invalid call target');
        const target=headers[expr.target];
        if((target.returnType??'int')!==expected)fail('call return type mismatch');
        const args=sequence(expr.args,128,'call args');
        if(args.length!==target.params.length)fail('call arity mismatch');
        if(target.module!==headers[owner].module && !target.pub)fail('cross-module private call');
        graph[owner].add(expr.target);
        return {kind:'call',target:expr.target,args:args.map((a,i)=>
          node(a,owner,depth+1,target.paramTypes?.[i]??'int',active))};
      }
      case 'namedCall': {
        record(expr,['kind','target','args','paramOrder'],'named call');
        if(!Number.isSafeInteger(expr.target)||Object.is(expr.target,-0)||
           expr.target<0||expr.target>=headers.length)fail('invalid named call target');
        const target=headers[expr.target];
        if((target.returnType??'int')!==expected)fail('named call return type mismatch');
        const args=sequence(expr.args,128,'named call args');
        const order=sequence(expr.paramOrder,128,'named call parameter order');
        if(args.length!==target.params.length||order.length!==args.length)
          fail('named call arity mismatch');
        const seen=new Set();
        const normalizedOrder=order.map(slot=>{
          if(!Number.isSafeInteger(slot)||Object.is(slot,-0)||slot<0||
             slot>=target.params.length||seen.has(slot))
            fail('invalid named call parameter order');
          seen.add(slot);return slot;
        });
        if(seen.size!==target.params.length)fail('incomplete named call parameter order');
        if(target.module!==headers[owner].module&&!target.pub)
          fail('cross-module private named call');
        graph[owner].add(expr.target);
        return {kind:'namedCall',target:expr.target,
          args:args.map((argument,i)=>node(argument,owner,depth+1,
            target.paramTypes?.[normalizedOrder[i]]??'int',active)),
          paramOrder:normalizedOrder};
      }
      case 'intrinsic': {
        record(expr,['kind','name','args'],'intrinsic');
        const signatures={
          'Option.some':[['int'],'option<int>'],
          'Option.none':[[],'option<int>'],
          'Option.is_some':[['option<int>'],'bool'],
          'Option.unwrap_or':[['option<int>','int'],'int'],
          'Result.ok':[['int'],'result<int,int>'],
          'Result.err':[['int'],'result<int,int>'],
          'Result.is_ok':[['result<int,int>'],'bool'],
          'Result.unwrap_or':[['result<int,int>','int'],'int'],
          'Result.unwrap_err_or':[['result<int,int>','int'],'int']
        };
        if(typeof expr.name!=='string'||!Object.hasOwn(signatures,expr.name))
          fail('unknown portable intrinsic');
        const [types,result]=signatures[expr.name];
        if(expected!==result)fail('intrinsic return type mismatch');
        const args=sequence(expr.args,2,'intrinsic args');
        if(args.length!==types.length)fail('intrinsic arity mismatch');
        return {kind:'intrinsic',name:expr.name,
          args:args.map((argument,i)=>node(argument,owner,depth+1,types[i],active))};
      }
      case 'adtMatch': {
        record(expr,['kind','adt','subject','arms'],'ADT match');
        if(expr.adt!=='option<int>'&&expr.adt!=='result<int,int>')
          fail('unknown ADT match type');
        const subject=node(expr.subject,owner,depth+1,expr.adt,active);
        const variants=expr.adt==='option<int>'?['Some','None']:['Ok','Err'];
        const arms=sequence(expr.arms,2,'ADT match arms');
        if(arms.length!==2)fail('non-exhaustive ADT match');
        const seen=new Set(),checked=[];
        for(const arm of arms){
          record(arm,['tag','slot','body'],'ADT match arm');
          if(!variants.includes(arm.tag)||seen.has(arm.tag))
            fail('ADT match has duplicate or inappropriate variant');
          seen.add(arm.tag);
          const payload=arm.tag!=='None';
          if(payload) {
            if(!Number.isSafeInteger(arm.slot)||Object.is(arm.slot,-0)||arm.slot<0||
               arm.slot>=LIMIT_NODES||captureSlots[owner].has(arm.slot)||active.includes(arm.slot))
              fail('invalid or repeated ADT payload slot');
            captureSlots[owner].add(arm.slot);
          } else if(arm.slot!==null)fail('None arm cannot bind a payload');
          const scopes=payload?[...active,arm.slot]:active;
          checked.push({tag:arm.tag,slot:arm.slot,
            body:node(arm.body,owner,depth+1,expected,scopes)});
        }
        if(seen.size!==2)fail('non-exhaustive ADT match');
        return {kind:'adtMatch',adt:expr.adt,subject,arms:checked};
      }
      case 'match': {
        record(expr,['kind','subject','arms'],'match');
        const subject=node(expr.subject,owner,depth+1,'int',active);
        const arms=sequence(expr.arms,256,'match arms');
        if(!arms.length)fail('empty match');
        let wildcard=false;
        const literals=new Set();
        const checked=arms.map(arm=>{
          record(arm,['value','body'],'match arm');
          let value;
          if(arm.value===null) {
            if(wildcard)fail('duplicate wildcard');
            wildcard=true;value=null;
          } else {
            if(wildcard)fail('unreachable arm after wildcard');
            value=int(arm.value);
            if(literals.has(value))fail('duplicate scalar pattern');
            literals.add(value);
          }
          return {value,body:node(arm.body,owner,depth+1,expected,active)};
        });
        if(!wildcard)fail('non-exhaustive int match');
        return {kind:'match',subject,arms:checked};
      }
      default:fail('unsupported expression kind');
    }
  }
  function methodNode(expr,method,depth=0,expected=method.returnType){
    if(++nodes>LIMIT_NODES||depth>LIMIT_DEPTH)fail('method expression complexity exceeded');
    if(!expr||typeof expr!=='object'||Array.isArray(expr))fail('invalid method expression');
    const desc=Object.getOwnPropertyDescriptor(expr,'kind');
    if(!desc||!Object.hasOwn(desc,'value'))fail('invalid method expression kind');
    switch(desc.value){
      case 'int':
        record(expr,['kind','value'],'method int');
        if(expected!=='int')fail('method int type mismatch');
        return {kind:'int',value:int(expr.value)};
      case 'bool':
        record(expr,['kind','value'],'method bool');
        if(expected!=='bool'||typeof expr.value!=='boolean')fail('method bool type mismatch');
        return {kind:'bool',value:expr.value};
      case 'symbol':
        record(expr,['kind','value'],'method Symbol');
        if(expected!=='symbol')fail('method Symbol type mismatch');
        return {kind:'symbol',value:symbolName(expr.value)};
      case 'param':
        record(expr,['kind','index'],'method param');
        if(!Number.isSafeInteger(expr.index)||Object.is(expr.index,-0)||expr.index<0||
           expr.index>=method.params.length)fail('out-of-bounds method parameter');
        if(method.paramTypes[expr.index]!==expected)fail('method parameter type mismatch');
        return {kind:'param',index:expr.index};
      case 'neg':
        record(expr,['kind','inner'],'method neg');
        if(expected!=='int')fail('method negation type mismatch');
        return {kind:'neg',inner:methodNode(expr.inner,method,depth+1,'int')};
      case 'not':
        record(expr,['kind','inner'],'method not');
        if(expected!=='bool')fail('method boolean negation type mismatch');
        return {kind:'not',inner:methodNode(expr.inner,method,depth+1,'bool')};
      case 'binary':
        record(expr,['kind','op','left','right'],'method binary');
        if(expected!=='int'||!['+','-','*','%'].includes(expr.op))
          fail('unsupported method arithmetic');
        return {kind:'binary',op:expr.op,
          left:methodNode(expr.left,method,depth+1,'int'),
          right:methodNode(expr.right,method,depth+1,'int')};
      case 'compare':
        record(expr,['kind','op','left','right'],'method compare');
        if(expected!=='bool'||!['<','>','<=','>=','==','!='].includes(expr.op))
          fail('unsupported method comparison');
        return {kind:'compare',op:expr.op,
          left:methodNode(expr.left,method,depth+1,'int'),
          right:methodNode(expr.right,method,depth+1,'int')};
      case 'symbolCompare':
        record(expr,['kind','op','left','right'],'method Symbol compare');
        if(expected!=='bool'||(expr.op!=='=='&&expr.op!=='!='))
          fail('unsupported method Symbol comparison');
        return {kind:'symbolCompare',op:expr.op,
          left:methodNode(expr.left,method,depth+1,'symbol'),
          right:methodNode(expr.right,method,depth+1,'symbol')};
      case 'if':
        record(expr,['kind','condition','yes','no'],'method if');
        return {kind:'if',
          condition:methodNode(expr.condition,method,depth+1,'bool'),
          yes:methodNode(expr.yes,method,depth+1,expected),
          no:methodNode(expr.no,method,depth+1,expected)};
      case 'intrinsic': {
        record(expr,['kind','name','args'],'method intrinsic');
        const signatures={
          'Option.some':[['int'],'option<int>'],'Option.none':[[],'option<int>'],
          'Option.is_some':[['option<int>'],'bool'],'Option.unwrap_or':[['option<int>','int'],'int'],
          'Result.ok':[['int'],'result<int,int>'],'Result.err':[['int'],'result<int,int>'],
          'Result.is_ok':[['result<int,int>'],'bool'],
          'Result.unwrap_or':[['result<int,int>','int'],'int'],
          'Result.unwrap_err_or':[['result<int,int>','int'],'int']
        };
        if(typeof expr.name!=='string'||!Object.hasOwn(signatures,expr.name))
          fail('unknown method intrinsic');
        const [types,result]=signatures[expr.name];
        if(result!==expected)fail('method intrinsic return type mismatch');
        const args=sequence(expr.args,2,'method intrinsic args');
        if(args.length!==types.length)fail('method intrinsic arity mismatch');
        return {kind:'intrinsic',name:expr.name,
          args:args.map((arg,i)=>methodNode(arg,method,depth+1,types[i]))};
      }
      default:fail('unsupported method expression kind '+desc.value);
    }
  }
  const functions=headers.map((f,i)=>({...f,body:node(sourceFunctions[i].body,i,0,f.returnType??'int')}));
  const classes=classHeaders.map(cls=>({
    name:cls.name,pub:cls.pub,
    methods:cls.methods.map(method=>({
      ...method,
      body:method.returnType==='void'?null:methodNode(method.body,method,0,method.returnType)
    }))
  }));
  const color=new Uint8Array(headers.length);
  function visit(i) {
    if(color[i]===1)fail('recursive call graph unsupported pending fuel');
    if(color[i]===2)return;
    color[i]=1;for(const j of graph[i])visit(j);color[i]=2;
  }
  functions.forEach((_,i)=>visit(i));
  return {
    schemaVersion:PROGRAM_IR_VERSION,dialect:PROGRAM_IR_DIALECT,
    integerModel:PROGRAM_IR_INT_MODEL,sourceNamespace:namespace,
    modules:moduleNames,functions,
    ...(hasClasses?{classes}:{})
  };
}
export function stringifyProgramIRV2(ir){
  return JSON.stringify(validateProgramIRV2(ir));
}
