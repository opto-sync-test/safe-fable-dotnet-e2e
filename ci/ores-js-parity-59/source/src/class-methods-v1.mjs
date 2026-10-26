import {
  PROGRAM_IR_VERSION,PROGRAM_IR_DIALECT,PROGRAM_IR_INT_MODEL
} from './program-ir-v2.mjs';
import {
  compileProgramV2,compileProgramIRV2,compileToProgramIRV2
} from './program-v2.mjs';
import {
  CLASS_METHOD_IR_VERSION,CLASS_METHOD_IR_DIALECT,CLASS_METHOD_IR_INT_MODEL,
  validateClassMethodIRV1
} from './class-method-ir-v1.mjs';

/**
 * Compatibility adapter for the old --class-methods-v1 surface.
 * Parsing, resolution, typing and ESM generation now delegate to program-v2.
 * The legacy IR validator remains only as a stable data-format boundary.
 */
export class ClassMethodsError extends Error {
  constructor(message){super('error: class methods v1 compatibility: '+message);this.name='ClassMethodsError';}
}
const fail=message=>{throw new ClassMethodsError(message);};

function legacyBodyFromProgram(body,returnType){
  if(returnType==='void'){
    if(body!==null)fail('legacy void method body must lower to null');
    return {kind:'void'};
  }
  if(returnType!=='int')fail('legacy profile supports only int/void results');
  if(body?.kind==='int')return {kind:'literal',value:body.value};
  if(body?.kind==='param')return {kind:'arg',index:body.index};
  fail('source exceeds legacy class-method-v1 body subset');
}
function programBodyFromLegacy(body){
  if(body.kind==='void')return null;
  if(body.kind==='literal')return {kind:'int',value:body.value};
  if(body.kind==='arg')return {kind:'param',index:body.index};
  fail('unsupported legacy method body');
}
function projectLegacy(program){
  if(program.modules.length||program.functions.length||!program.classes?.length)
    fail('legacy profile requires class declarations only');
  return validateClassMethodIRV1({
    schemaVersion:CLASS_METHOD_IR_VERSION,
    dialect:CLASS_METHOD_IR_DIALECT,
    integerModel:CLASS_METHOD_IR_INT_MODEL,
    classes:program.classes.map(cls=>({
      name:cls.name,pub:cls.pub,
      methods:cls.methods.map(method=>{
        if(method.paramTypes.some(type=>type!=='int'))
          fail('legacy profile supports only int parameters');
        if(method.returnType!=='int'&&method.returnType!=='void')
          fail('legacy profile supports only int/void results');
        return {
          name:method.name,pub:method.pub,paramTypes:[...method.paramTypes],
          resultType:method.returnType,
          body:legacyBodyFromProgram(method.body,method.returnType)
        };
      })
    }))
  });
}
function programFromLegacy(input){
  const legacy=validateClassMethodIRV1(input);
  return {
    schemaVersion:PROGRAM_IR_VERSION,
    dialect:PROGRAM_IR_DIALECT,
    integerModel:PROGRAM_IR_INT_MODEL,
    sourceNamespace:null,modules:[],functions:[],
    classes:legacy.classes.map(cls=>({
      name:cls.name,pub:cls.pub,
      methods:cls.methods.map(method=>({
        name:method.name,pub:method.pub,
        params:method.paramTypes.map((_,i)=>'p'+i),
        paramTypes:[...method.paramTypes],
        returnType:method.resultType,
        body:programBodyFromLegacy(method.body)
      }))
    }))
  };
}
export function compileToClassMethodIRV1(source){
  return projectLegacy(compileToProgramIRV2(source));
}
export function compileClassMethodIRV1(input){
  return compileProgramIRV2(programFromLegacy(input));
}
export function compileClassMethodsV1(source){
  // Project first so richer program-v2 class features cannot silently widen the
  // historical class-methods-v1 source profile.
  compileToClassMethodIRV1(source);
  return compileProgramV2(source);
}
export function checkClassMethodsV1(source){
  compileClassMethodsV1(source);return true;
}
