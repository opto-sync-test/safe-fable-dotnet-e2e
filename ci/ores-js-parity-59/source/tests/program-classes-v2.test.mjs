import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileProgramV2,compileToProgramIRV2,compileProgramIRV2
} from '../src/program-v2.mjs';

const load=(source,suffix='')=>import('data:text/javascript;charset=utf-8,'+
  encodeURIComponent(compileProgramV2(source))+'#'+suffix);

test('program-v2 accepts exact implicit/explicit self zero-arity class methods',async()=>{
  const source=[
    'pub define class X1 as pub foo():void{} end',
    'pub define class X2 as pub foo(self):void{} end'
  ].join('\n');
  const ir=compileToProgramIRV2(source);
  assert.equal(ir.classes.length,2);
  assert.equal(ir.classes[0].methods[0].params.length,0);
  assert.equal(ir.classes[1].methods[0].params.length,0);
  const mod=await load(source,'self-zero');
  assert.equal(new mod.X1().foo(),undefined);
  assert.equal(new mod.X2().foo(),undefined);
  assert.throws(()=>new mod.X1(1n),/constructor arity mismatch/);
  assert.throws(()=>mod.X1.prototype.foo.call(new mod.X2()),/invalid Oreslang receiver/);
  assert.equal(Object.isFrozen(mod.X1.prototype),true);
  assert.equal(Object.isFrozen(mod.X1),true);
  assert.equal(Object.isExtensible(new mod.X1()),false);
  assert.throws(()=>{class Evil extends mod.X1{};new Evil();},/unsupported class derivation/);
});

test('typed method calls reuse named-argument binding and Symbol semantics',async()=>{
  const source=[
    'pub define class Box as',
    '  pub mtd pick(self,int a,int b):int{return a*10+b;}',
    '  pub method is_ready(self,Symbol s):bool{return s==#ready;}',
    'end',
    'pub fnc run():int{return new Box().pick(b:2,a:1);}',
    'pub fnc ready():bool{return new Box().is_ready(#ready);}'
  ].join('\n');
  const ir=compileToProgramIRV2(source);
  assert.equal(ir.functions[0].body.kind,'namedMethodCall');
  assert.deepEqual(ir.functions[0].body.paramOrder,[1,0]);
  assert.equal(ir.functions[1].body.kind,'methodCall');
  assert.equal(ir.classes[0].methods[1].body.kind,'symbolCompare');
  const mod=await load(source,'typed-methods');
  assert.equal(mod.run(),12n);
  assert.equal(mod.ready(),true);
  assert.equal(new mod.Box().pick(4n,5n),45n);
  assert.throws(()=>new mod.Box().pick(4n),/method arity mismatch/);
  assert.throws(()=>new mod.Box().pick(4n,5),/signed i64 BigInt/);
});

test('contextual mtd/method and Java callable keyword names survive convergence',async()=>{
  const source=[
    'pub define class mtd as',
    '  pub mtd do():int{return 1;}',
    '  pub method select() -> int :: return 2; end',
    '  pub mtd mtd():int{return 3;}',
    '  pub method mtd(int value):int{return value;}',
    '  pub method():int{return 4;}',
    '  pub done():int{return 5;}',
    '  pub true():int{return 6;}',
    'end'
  ].join('\n');
  const mod=await load(source,'callable-keywords');
  const x=new mod.mtd();
  assert.equal(x.do(),1n);
  assert.equal(x.select(),2n);
  assert.equal(x.mtd(),3n);
  assert.equal(x.mtd(9n),9n);
  assert.equal(x.method(),4n);
  assert.equal(x.done(),5n);
  assert.equal(x.true(),6n);
});

test('named method ABI reorder preserves lexical source evaluation order',async()=>{
  const source=[
    'define class Pick as pub pick(self,int a,int b):int{return a;} end',
    'pub fnc overflow_first():int{return new Pick().pick(b:9223372036854775807+1,a:1%0);}',
    'pub fnc zero_first():int{return new Pick().pick(a:1%0,b:9223372036854775807+1);}'
  ].join('\n');
  const mod=await load(source,'method-order');
  assert.throws(()=>mod.overflow_first(),/ORES_I64_OVERFLOW/);
  assert.throws(()=>mod.zero_first(),/ORES_I64_DIVISION_BY_ZERO/);
});

test('private methods and unsupported method-body call graph features fail closed',()=>{
  for(const source of [
    'define class X as secret():int{return 1;} end pub fnc f():int{return new X().secret();}',
    'define class X as pub f():int{return helper();} end fnc helper():int{return 1;}',
    'define class X as pub f():int{return new X().f();} end',
    'define class X as pub f(int x):int{return match x over on _ -> {1;} end;} end'
  ]) assert.throws(()=>compileProgramV2(source),/error: program v2:/,source);
});

test('direct class IR rejects forged targets, receiver confusion and parameter maps',()=>{
  const source=[
    'define class A as pub pick(self,int a,int b):int{return a;} end',
    'define class B as pub pick(self,int a,int b):int{return b;} end',
    'pub fnc run():int{return new A().pick(b:2,a:1);}'
  ].join('\n');
  const good=compileToProgramIRV2(source);
  assert.deepEqual(compileToProgramIRV2(source),good);
  const mutate=edit=>{
    const ir=JSON.parse(JSON.stringify(good));
    edit(ir);
    return ir;
  };
  const bad=[
    mutate(ir=>{ir.functions[0].body.classIndex=-0;}),
    mutate(ir=>{ir.functions[0].body.methodIndex=99;}),
    mutate(ir=>{ir.functions[0].body.receiver={kind:'newClass',classIndex:1};}),
    mutate(ir=>{ir.functions[0].body.paramOrder=[0,0];}),
    mutate(ir=>{ir.functions[0].body.paramOrder=[-0,1];}),
    mutate(ir=>{ir.functions[0].body.args[0]={kind:'bool',value:true};}),
    mutate(ir=>{ir.classes[0].methods[0].pub=false;}),
    mutate(ir=>{ir.classes[0].methods[0].body={kind:'call',target:0,args:[]};}),
    mutate(ir=>{ir.classes[0].methods[0].extra=true;}),
    mutate(ir=>{ir.classes[0].methods[0].returnType='void';}),
    mutate(ir=>{ir.classes[0].name='Option';}),
    mutate(ir=>{ir.classes[0].methods[0].params[0]='return';})
  ];
  for(const ir of bad)
    assert.throws(()=>compileProgramIRV2(ir),/error: program IR:/);
});

test('reserved class and method parameter identifiers fail closed',()=>{
  for(const source of [
    'define class new as end',
    'define class Symbol as end',
    'define class Option as end',
    'define class Result as end',
    'define class X as pub f(int return):int{return 1;} end',
    'define class X as pub f(int self):int{return 1;} end'
  ]) assert.throws(()=>compileProgramV2(source),/error: program v2:/,source);
});

test('class and method duplicate/collision boundaries fail closed',()=>{
  for(const source of [
    'define class X as foo():void{} foo(self):void{} end',
    'define class X as pub foo(int a):int{return a;} pub foo(self,int b):int{return b;} end',
    'define module X as pub fnc f():int{return 1;} end define class X as end',
    'pub define class X as end pub fnc X():int{return 1;}'
  ]) assert.throws(()=>compileProgramV2(source),/error: program v2:|error: program IR:/,source);
});

test('legacy function-only program-v2 keeps the legacy IR shape',()=>{
  const source='pub fnc add(int a,int b):int{return a+b;}';
  const ir=compileToProgramIRV2(source);
  assert.equal(Object.hasOwn(ir,'classes'),false);
  assert.deepEqual(Object.keys(ir).sort(),
    ['dialect','functions','integerModel','modules','schemaVersion','sourceNamespace'].sort());
  const esm=compileProgramV2(source);
  assert.doesNotMatch(esm,/_class\d+/);
  assert.equal(compileProgramIRV2(JSON.parse(JSON.stringify(ir))),esm);
});
