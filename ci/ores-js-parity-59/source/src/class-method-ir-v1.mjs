/**
 * Strict JSON-safe resolved IR for the experimental fieldless class-method backend.
 * This is a backend-local migration seam, not yet the shared canonical Oreslang IR.
 */
export const CLASS_METHOD_IR_VERSION=1;
export const CLASS_METHOD_IR_DIALECT='oreslang.class-methods';
export const CLASS_METHOD_IR_INT_MODEL='signed-i64-checked-provisional';

const ID=/^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DEC=/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
const MAX_CLASSES=512,MAX_METHODS=256,MAX_ARITY=32;
const RESERVED=new Set([
  'default','new','class','export','import','null','true','false','this','super',
  'extends','static','constructor','prototype','__proto__','define','pub','as',
  'end','self','int','void','return','mut','private','actor','fnc',
  'routine','bool','let','val','const','if','fi','then','else','await','task',
  'nb','do','done','stop','loop','block','select','readch','writech','spawn',
  'module','trait','interface','type','rt'
]);
const CALLABLE_KEYWORDS=new Set([
  'stop','do','done','loop','block','select','readch','writech','nb','true','false'
]);

export class ClassMethodIRError extends Error {
  constructor(detail){super('error: class method IR: '+detail);this.name='ClassMethodIRError';}
}
const fail=detail=>{throw new ClassMethodIRError(detail);};

function record(value,fields,context){
  if(value===null||typeof value!=='object'||Array.isArray(value))
    fail(context+': expected object');
  const proto=Object.getPrototypeOf(value);
  if(proto!==Object.prototype&&proto!==null)fail(context+': non-plain object');
  const keys=Reflect.ownKeys(value);
  if(keys.length!==fields.length||
     keys.some(k=>typeof k!=='string'||!fields.includes(k)))
    fail(context+': unexpected or missing field');
  for(const key of fields){
    const desc=Object.getOwnPropertyDescriptor(value,key);
    if(!desc||!Object.hasOwn(desc,'value'))fail(context+': accessor or missing field '+key);
  }
  return value;
}
function sequence(value,maximum,context){
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||
     value.length>maximum)fail(context+': invalid array');
  const keys=Reflect.ownKeys(value);
  if(keys.length!==value.length+1||
     keys.some(k=>k!=='length'&&(!/^(?:0|[1-9][0-9]*)$/.test(k)||
       Number(k)>=value.length)))fail(context+': unexpected array properties');
  for(let i=0;i<value.length;i++){
    const desc=Object.getOwnPropertyDescriptor(value,i);
    if(!desc||!Object.hasOwn(desc,'value'))fail(context+': sparse or accessor array');
  }
  return value;
}
export function isClassMethodIdentifierV1(value){
  return typeof value==='string'&&ID.test(value)&&!RESERVED.has(value);
}
export function isClassMethodCallableNameV1(value){
  return typeof value==='string'&&ID.test(value)&&
    (isClassMethodIdentifierV1(value)||CALLABLE_KEYWORDS.has(value));
}
function identifier(value,context){
  if(!isClassMethodIdentifierV1(value))fail(context+': invalid or reserved identifier');
  return value;
}
function integer(value){
  if(typeof value!=='string'||value.length>20||!DEC.test(value))
    fail('invalid canonical int literal');
  const n=BigInt(value);
  if(n<MIN||n>MAX)fail('int literal outside signed i64');
  return value;
}
function index(value,maximum,context){
  if(!Number.isSafeInteger(value)||Object.is(value,-0)||value<0||value>=maximum)
    fail(context+': out-of-range index');
  return value;
}
function body(value,resultType,arity){
  if(value===null||typeof value!=='object'||Array.isArray(value))
    fail('method body: expected object');
  const kind=Object.getOwnPropertyDescriptor(value,'kind');
  if(!kind||!Object.hasOwn(kind,'value'))fail('method body: missing/accessor kind');
  switch(kind.value){
    case 'void':
      record(value,['kind'],'void body');
      if(resultType!=='void')fail('void body/result mismatch');
      return {kind:'void'};
    case 'literal':
      record(value,['kind','value'],'literal body');
      if(resultType!=='int')fail('literal body/result mismatch');
      return {kind:'literal',value:integer(value.value)};
    case 'arg':
      record(value,['kind','index'],'argument body');
      if(resultType!=='int')fail('argument body/result mismatch');
      return {kind:'arg',index:index(value.index,arity,'method argument')};
    default:fail('unsupported method body kind');
  }
}

/**
 * Validate and defensively copy externally supplied class-method IR.
 * This is a format/type gate, not a JavaScript sandbox.
 */
export function validateClassMethodIRV1(input){
  record(input,['schemaVersion','dialect','integerModel','classes'],'program');
  if(input.schemaVersion!==CLASS_METHOD_IR_VERSION||
     input.dialect!==CLASS_METHOD_IR_DIALECT||
     input.integerModel!==CLASS_METHOD_IR_INT_MODEL)
    fail('unsupported IR version/dialect/integer model');
  const sourceClasses=sequence(input.classes,MAX_CLASSES,'classes');
  if(!sourceClasses.length)fail('no classes');
  const classNames=new Set();
  const classes=sourceClasses.map((cls,ci)=>{
    record(cls,['name','pub','methods'],'class');
    const name=identifier(cls.name,'class name');
    if(classNames.has(name))fail('duplicate class '+name);
    classNames.add(name);
    if(typeof cls.pub!=='boolean')fail('class visibility must be boolean');
    const slots=new Set();
    const methods=sequence(cls.methods,MAX_METHODS,'methods').map((method,mi)=>{
      record(method,['name','pub','paramTypes','resultType','body'],'method');
      const methodName=isClassMethodCallableNameV1(method.name)?method.name:
        fail('method name: invalid or reserved callable name');
      if(typeof method.pub!=='boolean')fail('method visibility must be boolean');
      const paramTypes=sequence(method.paramTypes,MAX_ARITY,'method parameters').map(type=>{
        if(type!=='int')fail('unsupported method parameter type');
        return 'int';
      });
      if(method.resultType!=='void'&&method.resultType!=='int')
        fail('unsupported method result type');
      const slot=methodName+'/'+paramTypes.length;
      if(slots.has(slot))fail('duplicate caller-visible method arity '+slot);
      slots.add(slot);
      return {
        name:methodName,pub:method.pub,paramTypes,resultType:method.resultType,
        body:body(method.body,method.resultType,paramTypes.length)
      };
    });
    return {name,pub:cls.pub,methods};
  });
  return {
    schemaVersion:CLASS_METHOD_IR_VERSION,
    dialect:CLASS_METHOD_IR_DIALECT,
    integerModel:CLASS_METHOD_IR_INT_MODEL,
    classes
  };
}

export function stringifyClassMethodIRV1(input){
  return JSON.stringify(validateClassMethodIRV1(input));
}
