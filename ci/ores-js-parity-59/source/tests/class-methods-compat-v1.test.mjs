import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileClassMethodsV1,compileToClassMethodIRV1,compileClassMethodIRV1,
  checkClassMethodsV1
} from '../src/class-methods-v1.mjs';
import {
  CLASS_METHOD_IR_VERSION,CLASS_METHOD_IR_DIALECT,CLASS_METHOD_IR_INT_MODEL
} from '../src/class-method-ir-v1.mjs';

const load=source=>import('data:text/javascript;charset=utf-8,'+
  encodeURIComponent(compileClassMethodsV1(source)));

test('legacy class-method source delegates through unified program-v2',async()=>{
  const source=[
    'pub define class X1 as pub foo():void{} end',
    'pub define class X2 as',
    '  pub mtd read(self,int value) -> int :: return value; end',
    'end'
  ].join('\n');
  assert.equal(checkClassMethodsV1(source),true);
  const ir=compileToClassMethodIRV1(source);
  assert.equal(ir.schemaVersion,CLASS_METHOD_IR_VERSION);
  assert.equal(ir.dialect,CLASS_METHOD_IR_DIALECT);
  assert.equal(ir.classes[0].methods[0].body.kind,'void');
  assert.deepEqual(ir.classes[1].methods[0].body,{kind:'arg',index:0});
  const mod=await load(source);
  assert.equal(new mod.X1().foo(),undefined);
  assert.equal(new mod.X2().read(7n),7n);
});

test('legacy direct IR compiles through unified program emitter',async()=>{
  const legacy={
    schemaVersion:CLASS_METHOD_IR_VERSION,
    dialect:CLASS_METHOD_IR_DIALECT,
    integerModel:CLASS_METHOD_IR_INT_MODEL,
    classes:[{
      name:'Box',pub:true,methods:[
        {name:'min',pub:true,paramTypes:[],resultType:'int',
          body:{kind:'literal',value:'-9223372036854775808'}},
        {name:'echo',pub:true,paramTypes:['int'],resultType:'int',
          body:{kind:'arg',index:0}}
      ]
    }]
  };
  const esm=compileClassMethodIRV1(legacy);
  const mod=await import('data:text/javascript;charset=utf-8,'+encodeURIComponent(esm));
  const box=new mod.Box();
  assert.equal(box.min(),-(1n<<63n));
  assert.equal(box.echo(9n),9n);
  assert.throws(()=>box.echo(9),/signed i64 BigInt/);
});

test('compatibility profile does not silently widen to richer program-v2 classes',()=>{
  for(const source of [
    'define class X as pub f(bool x):bool{return x;} end',
    'define class X as pub f(Symbol x):Symbol{return x;} end',
    'define class X as pub f(int x):int{return x+1;} end',
    'define class X as pub f():Option<int>{return Some(1);} end',
    'define class X as end pub fnc f():int{return 1;}'
  ]) assert.throws(()=>compileClassMethodsV1(source),/class methods v1 compatibility/);
});

test('legacy explicit self still erases before projected IR',()=>{
  const implicit=compileToClassMethodIRV1(
    'define class X as foo(int x):int{return x;} end'
  );
  const explicit=compileToClassMethodIRV1(
    'define class X as foo(self,int x):int{return x;} end'
  );
  assert.deepEqual(implicit,explicit);
});
