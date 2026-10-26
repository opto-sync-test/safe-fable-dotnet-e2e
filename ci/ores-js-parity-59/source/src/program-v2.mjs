import {validateProgramIRV2,PROGRAM_IR_VERSION,PROGRAM_IR_DIALECT,PROGRAM_IR_INT_MODEL} from './program-ir-v2.mjs';
/**
 * Experimental Oreslang program-to-ESM v2 slice:
 * flat runtime modules, private/public functions, qualified calls, integer matches.
 * Standalone parser until the shared typed frontend and IR become available.
 * DOES NOT implement classes, actors, imports, or the type-only namespace grammar.
 */
const MAX_BYTES = 262144, MAX_TOKENS = 30000, MAX_DEPTH = 192;
const MIN = -(1n << 63n), MAX = (1n << 63n) - 1n;
const TOKEN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLASS_METHOD_RESERVED=new Set([
  'default','new','class','export','import','null','this','super','extends','static',
  'constructor','prototype','__proto__','define','pub','as','end','self','int',
  'void','return','mut','private','actor','fnc','routine','bool','Symbol','let',
  'val','const','if','fi','then','else','await','task','spawn','module','trait',
  'interface','type','rt'
]);
const CLASS_METHOD_CALLABLE_KEYWORDS=new Set([
  'mtd','method','stop','do','done','loop','block','select','readch','writech',
  'nb','true','false'
]);
export class ProgramCompileError extends Error {
  constructor(message, loc) {
    super('error: program v2: ' + message + (loc ? ' at ' + loc.line + ':' + loc.col : ''));
    this.name = 'ProgramCompileError';
  }
}
const fail = (message, loc) => {throw new ProgramCompileError(message, loc);};

/**
 * Align source-profile negotiation with Java CheckedI64SourceHeader.
 * Provisional JS arithmetic stays checked for unmarked source too, but a
 * malformed or displaced explicit opt-in must never be silently ignored.
 * Only actual line-comment tokens count; block/quoted lookalikes do not.
 */
function requireWellFormedCheckedI64Header(source) {
  const directive='// oreslang:checked-i64-v1\n';
  const prefix='oreslang:checked-i64';
  const enabled=source.startsWith(directive);
  let depth=0,quote=null;
  for(let i=0;i<source.length;){
    const ch=source[i], next=source[i+1];
    if(quote!==null) {
      if(ch==='\\'&&i+1<source.length){i+=2;continue;}
      if(ch===quote)quote=null;
      i++;
      continue;
    }
    if(depth!==0) {
      if(ch==='/'&&next==='*'){depth++;i+=2;continue;}
      if(ch==='*'&&next==='/'){depth--;i+=2;continue;}
      i++;
      continue;
    }
    if(ch==='"'||ch==="'"){quote=ch;i++;continue;}
    if(ch==='/'&&next==='*'){depth=1;i+=2;continue;}
    if(ch==='/'&&next==='/'){
      const end=source.indexOf('\n',i);
      const stop=end<0?source.length:end;
      let marker=i+2;
      while(marker<stop&&' \t\r\v\f'.includes(source[marker]))marker++;
      if(source.startsWith(prefix,marker)&&(!enabled||i!==0))
        fail('checked-i64-v1: malformed, duplicated, displaced or unsupported directive');
      i=end<0?stop:end+1;
      continue;
    }
    i++;
  }
  return enabled;
}
function validateSourceText(source) {
  if(typeof source!=='string')fail('oversized or invalid source');
  // TextEncoder replaces lone UTF-16 surrogates. Reject before encoding so
  // comments and other lexically ignored regions cannot change byte identity.
  for(let i=0;i<source.length;i++){
    const unit=source.charCodeAt(i);
    if(unit===0)fail('NUL in source');
    if(unit>=0xd800&&unit<=0xdbff){
      const lo=source.charCodeAt(i+1);
      if(!(lo>=0xdc00&&lo<=0xdfff))fail('invalid UTF-16 source');
      i++;
    }else if(unit>=0xdc00&&unit<=0xdfff)fail('invalid UTF-16 source');
  }
}
function normalizeProcessSymbolName(input) {
  if(typeof input!=='string'||input.length>1024)
    fail('Symbol source name exceeds normalization budget');
  for(let i=0;i<input.length;i++){
    const unit=input.charCodeAt(i);
    if(unit>=0xd800&&unit<=0xdbff){
      const lo=input.charCodeAt(i+1);
      if(!(lo>=0xdc00&&lo<=0xdfff))fail('unpaired UTF-16 surrogate in Symbol');
      i++;
    }else if(unit>=0xdc00&&unit<=0xdfff)fail('unpaired UTF-16 surrogate in Symbol');
  }
  const value=input.normalize('NFC');
  const bytes=new TextEncoder().encode(value).length;
  if(bytes<1||bytes>256)fail('Symbol name requires 1..256 UTF-8 bytes');
  for(const ch of value){
    const cp=ch.codePointAt(0);
    if(cp<0x20||(cp>=0x7f&&cp<=0x9f)||/[\p{Cf}\p{Zl}\p{Zp}]/u.test(ch)||
       cp===0x061c||cp===0x200e||cp===0x200f||
       (cp>=0x202a&&cp<=0x202e)||(cp>=0x2066&&cp<=0x2069))
      fail('control, line-separator, or bidi character in Symbol');
  }
  return value;
}
function tokenize(source) {
  validateSourceText(source);
  if (new TextEncoder().encode(source).length > MAX_BYTES) fail('oversized or invalid source');
  requireWellFormedCheckedI64Header(source);
  const result = [];
  let pos = 0, line = 1, col = 1;
  function advance() {
    if (source[pos] === '\n') {line++; col = 1;} else col++;
    pos++;
  }
  function emit(kind, value, start) {
    if (result.length >= MAX_TOKENS) fail('token budget exceeded', start);
    result.push({kind, value, ...start});
  }
  while (pos < source.length) {
    const start = {line, col};
    const c = source[pos];
    if (/\s/.test(c)) {advance(); continue;}
    if (source.startsWith('//',pos)) {
      while (pos < source.length && source[pos] !== '\n') advance();
      continue;
    }
    if (source.startsWith('/*',pos)) {
      advance(); advance(); let nesting = 1;
      while (nesting && pos < source.length) {
        if (source.startsWith('/*',pos)) {
          if (++nesting > 64) fail('comment nesting exceeded',start);
          advance(); advance();
        } else if (source.startsWith('*/',pos)) {
          nesting--; advance(); advance();
        } else advance();
      }
      if (nesting) fail('unterminated comment',start);
      continue;
    }
    if (c==='#') {
      advance();
      let value='';
      const quote=source[pos];
      if(quote==='"'||quote==="'"){
        advance();
        let closed=false;
        while(pos<source.length){
          if(source[pos]===quote){advance();closed=true;break;}
          let ch=source[pos];
          if(ch==='\n'||ch==='\r')fail('raw newline in quoted Symbol literal',start);
          advance();
          if(ch==='\\'){
            if(pos>=source.length)fail('unterminated quoted Symbol escape',start);
            const escaped=source[pos];advance();
            if(escaped==='u'){
              let code=0;
              for(let i=0;i<4;i++){
                if(pos>=source.length)fail('incomplete Unicode Symbol escape',start);
                const digit=source[pos];advance();
                const hex=digit>='0'&&digit<='9'?digit.charCodeAt(0)-48:
                  digit>='a'&&digit<='f'?digit.charCodeAt(0)-87:
                  digit>='A'&&digit<='F'?digit.charCodeAt(0)-55:-1;
                if(hex<0)fail('invalid Unicode Symbol escape',start);
                code=(code<<4)|hex;
              }
              ch=String.fromCharCode(code);
            }else if(escaped==='n')ch='\n';
            else if(escaped==='r')ch='\r';
            else if(escaped==='t')ch='\t';
            else if(escaped==='"'||escaped==="'"||escaped==='\\')ch=escaped;
            else fail('invalid quoted Symbol escape',start);
          }
          value+=ch;
        }
        if(!closed)fail('unterminated quoted Symbol literal',start);
        value=normalizeProcessSymbolName(value);
      }else{
        if(pos>=source.length||!/[A-Za-z_]/.test(source[pos]))
          fail("expected Symbol name immediately after '#'",start);
        while(pos<source.length&&/[A-Za-z0-9_]/.test(source[pos])){
          value+=source[pos];advance();
        }
        if(value.length>128)fail('unquoted Symbol literal exceeds 128 ASCII bytes',start);
        value=normalizeProcessSymbolName(value);
      }
      emit('symbol',value,start);
    } else if (/[A-Za-z_]/.test(c)) {
      let word = '';
      while (pos < source.length && /[A-Za-z0-9_]/.test(source[pos])) {
        word += source[pos]; advance();
      }
      if (word.length > 128) fail('identifier limit',start);
      emit('id',word,start);
    } else if (/[0-9]/.test(c)) {
      let number = '';
      while (pos < source.length && /[0-9_]/.test(source[pos])) {
        number += source[pos]; advance();
      }
      if (number.length > 64 || !/^[0-9]+(?:_[0-9]+)*$/.test(number)) fail('invalid int literal',start);
      emit('int',number,start);
    } else if (['<=','>=','==','!='].some(op=>source.startsWith(op,pos))) {
      emit('sym',source.slice(pos,pos+2),start); advance(); advance();
    } else if (source.startsWith('->',pos) || source.startsWith('::',pos)) {
      emit('sym',source.slice(pos,pos+2),start); advance(); advance();
    } else if ('(){}:,;+-*/%=.<>!?'.includes(c)) {
      emit('sym',c,start); advance();
    } else fail('unsupported character',start);
  }
  emit('eof','<eof>',{line,col});
  return result;
}
class Parser {
  constructor(tokens) {this.tokens = tokens;this.i = 0;this.depth = 0;this.expressions = 0;this.statementNodes = 0;}
  peek() {return this.tokens[this.i];}
  eat(s) {if(this.peek().value === s) {this.i++; return true;} return false;}
  expect(s) {if(!this.eat(s)) fail('expected ' + s + ', found ' + this.peek().value,this.peek());}
  name() {
    const t = this.peek();
    if (t.kind !== 'id' || !TOKEN_NAME.test(t.value)) fail('identifier expected',t);
    this.i++; return t.value;
  }
  classIdentifier() {
    const t=this.peek(),value=t.value;
    if(t.kind!=='id'||!TOKEN_NAME.test(value)||CLASS_METHOD_RESERVED.has(value)||
       value==='Option'||value==='Result')
      fail('invalid or reserved class/member identifier '+value,t);
    this.i++;return value;
  }
  callableName() {
    const t=this.peek(),value=t.value;
    if(t.kind!=='id'||!TOKEN_NAME.test(value)||
       (CLASS_METHOD_RESERVED.has(value)&&!CLASS_METHOD_CALLABLE_KEYWORDS.has(value)))
      fail('invalid or reserved callable name '+value,t);
    this.i++;return value;
  }
  eatMethodMarker() {
    const marker=this.peek().value;
    if(marker!=='mtd'&&marker!=='method')return false;
    const next=this.tokens[this.i+1],after=this.tokens[this.i+2];
    if(!next||next.kind!=='id'||after?.value!=='(')return false;
    const value=next.value;
    if(CLASS_METHOD_RESERVED.has(value)&&!CLASS_METHOD_CALLABLE_KEYWORDS.has(value))
      return false;
    this.i++;return true;
  }
  argumentsAfterOpen() {
    const args=[];let namedSeen=false;
    if(!this.eat(')')) {
      do {
        if(args.length>=128)fail('argument limit',this.peek());
        let name=null;
        if(this.peek().kind==='id'&&this.tokens[this.i+1]?.value===':'){
          name=this.name();this.expect(':');namedSeen=true;
        }else if(namedSeen)fail('positional argument cannot follow a named argument',this.peek());
        args.push({name,expr:this.expression()});
      } while(this.eat(','));
      this.expect(')');
    }
    return args;
  }
  valueType() {
    if(this.eat('int'))return 'int';
    if(this.eat('bool'))return 'bool';
    if(this.eat('Symbol'))return 'symbol';
    if(this.eat('Option')){
      this.expect('<');this.expect('int');this.expect('>');
      return 'option<int>';
    }
    if(this.eat('Result')){
      this.expect('<');this.expect('int');this.expect(',');this.expect('int');this.expect('>');
      return 'result<int,int>';
    }
    fail('unsupported scalar type (int, bool, Symbol, Option<int>, Result<int,int>)',this.peek());
  }
  classDeclaration(pub) {
    const name=this.classIdentifier();
    this.expect('as');
    const methods=[],slots=new Set();
    while(!this.eat('end')) {
      if(this.peek().kind==='eof')fail('unterminated class '+name,this.peek());
      if(methods.length>=256)fail('method count limit',this.peek());
      const methodPub=this.eat('pub');
      this.eatMethodMarker();
      const methodName=this.callableName();
      this.expect('(');
      if(this.eat('self')){
        if(this.eat(',')){
          if(this.peek().value===')')fail('trailing receiver comma',this.peek());
        }else if(this.peek().value!==')')fail('unsupported self parameter spelling',this.peek());
      }
      const params=[],paramTypes=[];
      if(!this.eat(')')){
        do {
          if(params.length>=32)fail('method arity budget',this.peek());
          const type=this.valueType();
          const param=this.classIdentifier();
          if(param==='self'||params.includes(param))fail('duplicate or reserved method parameter '+param,this.peek());
          params.push(param);paramTypes.push(type);
        } while(this.eat(','));
        this.expect(')');
      }
      const arrow=this.eat('->');
      if(!arrow)this.expect(':');
      const returnType=this.eat('void')?'void':this.valueType();
      const braced=this.eat('{');
      if(!braced){
        if(!arrow)fail('colon method bodies require braces',this.peek());
        this.expect('::');
      }
      const terminator=braced?'}':'end';
      let body=null;
      if(returnType==='void'){
        if(this.eat('return'))this.expect(';');
        if(this.peek().value!==terminator)
          fail('void method body unsupported in convergence slice',this.peek());
      }else{
        const statements=this.statementSequence([terminator]);
        body=this.lowerStatements(statements,null);
        if(!body)fail('method requires a return on every path',this.peek());
        this.checkExpandedBudget(body);
      }
      this.expect(terminator);
      const slot=methodName+'/'+params.length;
      if(slots.has(slot))fail('duplicate method name/arity '+slot,this.peek());
      slots.add(slot);
      methods.push({name:methodName,pub:methodPub,params,paramTypes,returnType,body});
    }
    return {name,pub,methods};
  }
  functions(moduleName) {
    const pub = this.eat('pub'), start=this.peek();
    if (!this.eat('fnc') && !this.eat('routine')) fail('unsupported declaration',start);
    const kind = this.tokens[this.i-1].value, name = this.name();
    this.expect('(');
    const params = [], paramTypes = [];
    if (!this.eat(')')) {
      do {
        if (params.length >= 128) fail('parameter limit',this.peek());
        const type=this.valueType();
        const p = this.name();
        if (params.includes(p)) fail('duplicate parameter ' + p);
        params.push(p); paramTypes.push(type);
      } while(this.eat(','));
      this.expect(')');
    }
    // Bound source-level control flow to total-returning integer functions.
    // This is a freestanding core slice, not generic statement lowering.
    const arrow=this.eat('->');
    if(!arrow)this.expect(':');
    const returnType=this.valueType();
    const braced=this.eat('{');
    if(!braced&&!arrow)fail('expected { for colon function body',this.peek());
    if(!braced){if(!this.eat('as'))this.eat('::');}
    const statements=this.statementSequence([braced?'}':'end']);
    this.expect(braced?'}':'end');
    const body=this.lowerStatements(statements,null);
    if(!body)fail('int function requires a return on every path');
    this.checkExpandedBudget(body);
    // Exporting a routine as a module object property would make a
    // direct-call-only routine first class. Leave this for runtime/ABI design.
    if (pub && kind === 'routine') fail('public routine cannot be exported');
    const fn={module:moduleName, name, kind, pub, params, body};
    // Keep the historical integer-only IR exactly stable for old consumers.
    // New typed fields are an all-or-nothing additive extension for bool.
    if(returnType!=='int'||paramTypes.some(type=>type!=='int')){
      fn.paramTypes=paramTypes;fn.returnType=returnType;
    }
    return fn;
  }
  statementSequence(terminators,depth=0) {
    if(depth>64)fail('conditional nesting budget exceeded',this.peek());
    const statements=[];
    while(this.peek().kind!=='eof'&&!terminators.includes(this.peek().value)) {
      if(++this.statementNodes>MAX_TOKENS)fail('statement budget exceeded',this.peek());
      if(this.eat('return')) {
        const body=this.expression();
        this.expect(';');
        statements.push({kind:'return',body});
      } else if(this.eat('if')) {
        const condition=this.expression();
        // Canonical statement-only `if`; retain old ; do syntax.
        if(!this.eat('then')){this.expect(';');this.expect('do');}
        const yes=this.statementSequence(['else','fi'],depth+1);
        const no=this.eat('else')?this.statementSequence(['fi'],depth+1):[];
        this.expect('fi');
        statements.push({kind:'branch',condition,yes,no});
      } else fail('unsupported statement in int function',this.peek());
    }
    if(this.peek().kind==='eof')fail('unterminated function or conditional',this.peek());
    return statements;
  }
  returnsOnAllPaths(stmts) {
    if(!stmts.length)return false;
    const last=stmts[stmts.length-1];
    return last.kind==='return'||
      (last.kind==='branch'&&this.returnsOnAllPaths(last.yes)&&this.returnsOnAllPaths(last.no));
  }
  lowerStatements(stmts,fallback) {
    let result=fallback;
    for(let i=stmts.length-1;i>=0;i--) {
      const stmt=stmts[i];
      if(i<stmts.length-1 &&
         (stmt.kind==='return' ||
          (this.returnsOnAllPaths(stmt.yes||[])&&this.returnsOnAllPaths(stmt.no||[]))))
        fail('unreachable statement after terminating return/if');
      if(stmt.kind==='return')result=stmt.body;
      else {
        const yes=this.lowerStatements(stmt.yes,result);
        const no=this.lowerStatements(stmt.no,result);
        if(!yes||!no)fail('int function requires return on every if branch');
        result={kind:'if',condition:stmt.condition,yes,no};
      }
    }
    return result;
  }
  // Fall-through after sequential if statements can share a continuation
  // between both branches. The AST is a DAG in memory, but resolving or
  // serializing it expands every occurrence into an IR tree. Detect exponential
  // amplification *before* resolution, JSON, or codegen work begins.
  checkExpandedBudget(root) {
    const memo=new WeakMap();
    function size(expr,depth=0) {
      if(depth>MAX_DEPTH)fail('expanded expression depth exceeded');
      if(memo.has(expr))return memo.get(expr);
      let total=1;
      function add(next) {
        if(next===null||typeof next!=='object')fail('invalid expression during lowering');
        total+=size(next,depth+1);
        if(total>MAX_TOKENS)fail('expanded conditional IR node budget exceeded');
      }
      switch(expr.kind){
        case 'int':case 'bool':case 'symbol':case 'variable':break;
        case 'neg':case 'not':add(expr.inner);break;
        case 'binary':case 'compare':add(expr.left);add(expr.right);break;
        case 'if':add(expr.condition);add(expr.yes);add(expr.no);break;
        case 'newClass':for(const arg of expr.args)add(arg.expr??arg);break;
        case 'methodCall':
          add(expr.receiver);for(const arg of expr.args)add(arg.expr??arg);break;
        case 'call':case 'intrinsic':for(const arg of expr.args)add(arg.expr??arg);break;
        case 'match':case 'adtMatch':
          add(expr.subject);
          for(const arm of expr.arms)add(arm.body);
          break;
        default:fail('unrecognized lowered expression');
      }
      memo.set(expr,total);
      return total;
    }
    size(root);
  }
  parse() {
    // Oreslang's flat source namespace is compile-time package metadata,
    // not a runtime module/object. It must occur only once at file start.
    let namespace = null;
    if (this.eat('namespace')) {
      namespace = this.name();
      this.expect(';');
    }
    const modules=[],functions=[],classes=[],usedModules=new Set(),usedClasses=new Set();
    while(this.peek().kind!=='eof'){
      let prefixPub=false;
      if(this.peek().value==='pub'&&this.tokens[this.i+1]?.value==='define'){
        this.i++;prefixPub=true;
      }
      if(this.eat('define')){
        const afterPub=this.eat('pub');
        const declarationPub=prefixPub||afterPub;
        if(this.peek().value==='symbol')
          fail('Symbol declaration/export manifest not implemented',this.peek());
        if(this.eat('class')){
          if(classes.length>=512)fail('class declaration budget exceeded',this.peek());
          const cls=this.classDeclaration(declarationPub);
          if(usedClasses.has(cls.name)||usedModules.has(cls.name))
            fail('duplicate class/module name '+cls.name,this.peek());
          usedClasses.add(cls.name);classes.push(cls);
          continue;
        }
        if(declarationPub)fail('public define is only supported for classes in program-v2',this.peek());
        this.expect('module');const name=this.name();
        if(name==='Option'||name==='Result'||name==='Symbol')
          fail('reserved portable intrinsic module name '+name);
        if(usedModules.has(name)||usedClasses.has(name))fail('duplicate module/class name '+name);
        usedModules.add(name);this.eat('as');modules.push(name);
        let count=0;
        while(!this.eat('end')){
          if(this.peek().kind==='eof')fail('unterminated module '+name,this.peek());
          if(++count>512||functions.length>=512)fail('declaration budget exceeded',this.peek());
          functions.push(this.functions(name));
        }
      }else{
        if(functions.length>=512)fail('declaration budget exceeded',this.peek());
        functions.push(this.functions(null));
      }
    }
    if(!functions.length&&!modules.length&&!classes.length)fail('empty program');
    return {namespace,modules,functions,classes};
  }
  integer(negative = false) {
    const token=this.peek();
    if (token.kind !== 'int') fail('integer literal expected',token);
    this.i++;
    const n=BigInt(token.value.replaceAll('_','')) * (negative ? -1n : 1n);
    if (n < MIN || n > MAX) fail('int literal outside provisional signed i64',token);
    return n.toString();
  }
  expression(min=0) {
    if (++this.depth > MAX_DEPTH || ++this.expressions > MAX_TOKENS) fail('expression budget exceeded',this.peek());
    try {
      let left = this.primary();
      while (true) {
        const op = this.peek().value;
        if (op==='?' && min<=1) {
          this.i++;
          const yes=this.expression();
          this.expect(':');
          const no=this.expression(1); // right associative, branches remain lazy
          left={kind:'if',condition:left,yes,no};
          continue;
        }
        if (op === '/') fail('division unsupported in provisional int profile',this.peek());
        const compare=['<','>','<=','>=','==','!='].includes(op);
        const prec=op==='*'||op==='%'?20:op==='+'||op==='-'?10:compare?5:-1;
        if (prec < min) break;
        this.i++;
        left={kind:compare?'compare':'binary',op,left,right:this.expression(prec+1)};
      }
      return left;
    } finally {this.depth--;}
  }
  primary() {
    if(this.eat('!'))return {kind:'not',inner:this.expression(30)};
    if(this.eat('new')){
      const className=this.name();
      this.expect('(');
      let receiver={kind:'newClass',name:className,args:this.argumentsAfterOpen()};
      while(this.eat('.')){
        const name=this.callableName();
        this.expect('(');
        receiver={kind:'methodCall',receiver,name,args:this.argumentsAfterOpen()};
      }
      return receiver;
    }
    if(this.eat('true'))return {kind:'bool',value:true};
    if(this.eat('false'))return {kind:'bool',value:false};
    if (this.eat('-')) {
      if(this.peek().kind === 'int') return {kind:'int',value:this.integer(true)};
      return {kind:'neg',inner:this.expression(30)};
    }
    if(this.eat('+')) return this.expression(30);
    if(this.eat('(')) {
      const e=this.expression();this.expect(')'); return e;
    }
    if(this.eat('match')) return this.matchExpression();
    if(this.peek().kind==='int') return {kind:'int',value:this.integer()};
    if(this.peek().kind==='symbol'){
      const literal=this.tokens[this.i++];
      return {kind:'symbol',value:literal.value};
    }
    const token=this.peek();
    if (token.kind !== 'id') fail('expression expected',token);
    const first=this.name();
    let qualifier=null, symbol=first;
    if(this.eat('.')) {qualifier=first; symbol=this.name();}
    if (!this.eat('(')) {
      if (qualifier) fail('bare module properties not yet supported',token);
      // Existing Oreslang Option constructor spelling: bare None.
      if(first==='None')return {kind:'call',qualifier:'Option',name:'none',args:[]};
      return {kind:'variable', name:first};
    }
    const args=this.argumentsAfterOpen();
    // Canonical Oreslang constructors also work as pure aliases for the
    // same statically checked intrinsics; don't introduce any new host API.
    if(qualifier===null){
      const constructors={Some:['Option','some'],Ok:['Result','ok'],Err:['Result','err']};
      if(Object.hasOwn(constructors,symbol)){
        const [scope,name]=constructors[symbol];
        return {kind:'call',qualifier:scope,name,args};
      }
    }
    return {kind:'call',qualifier,name:symbol,args};
  }
  matchExpression() {
    const subject=this.expression();
    this.eat('over');
    const braced=this.eat('{');
    const arms=[],seen=new Set();
    let family=null,wildcard=false;
    const ended=()=>braced?this.peek().value==='}':this.peek().value==='end';
    while(!ended()&&this.peek().kind!=='eof') {
      let tag=null, bind=null, value=null;
      if(this.eat('else')) {
        if(family==='adt')fail('ADT match requires exhaustive named variants, not else');
        family='int';tag='wildcard';
      } else {
        this.expect('on');
        const at=this.peek();
        if(this.eat('_')){
          if(family==='adt')fail('ADT match forbids wildcard');
          family='int';tag='wildcard';
        } else if(['Some','None','Ok','Err'].includes(at.value)){
          if(family==='int')fail('cannot mix integer and ADT patterns',at);
          family='adt';tag=this.name();
          if(tag==='None') {
            if(this.peek().value==='(')fail('None has no payload',this.peek());
          } else {
            this.expect('(');bind=this.name();this.expect(')');
            if(bind==='_'||['None','Some','Ok','Err'].includes(bind))
              fail('unsupported ADT payload binding name',at);
          }
        } else {
          if(family==='adt')fail('cannot mix ADT and integer patterns',at);
          family='int';tag='integer';
          value=this.integer(this.eat('-'));
        }
      }
      if(wildcard)fail('unreachable arm after wildcard',this.peek());
      if(tag==='wildcard')wildcard=true;
      const key=tag==='integer'?'int:'+value:tag;
      if(seen.has(key))fail('duplicate match pattern '+key);
      seen.add(key);
      this.eat('->');
      this.expect('{');
      // Existing Oreslang ADT fixture uses statement-looking return bodies
      // inside a match expression. Treat that spelling as an expression arm.
      if(this.peek().value==='return') {
        if(family!=='adt')fail('return in scalar expression match is unsupported');
        this.i++;
      }
      const body=this.expression();
      this.expect(';');this.expect('}');
      arms.push({tag,bind,value,body});
      if(arms.length>256)fail('match arm limit');
    }
    this.expect(braced?'}':'end');
    if(family==='adt') {
      const tags=new Set(arms.map(arm=>arm.tag));
      const option=tags.has('Some')||tags.has('None');
      const result=tags.has('Ok')||tags.has('Err');
      if(option&&result)fail('cannot mix Option and Result variant patterns');
      const required=option?['Some','None']:['Ok','Err'];
      if(arms.length!==2||required.some(tag=>!tags.has(tag)))
        fail('non-exhaustive ADT match; expected '+required.join('/'));
      return {kind:'adtMatch',adt:option?'option<int>':'result<int,int>',
        subject,arms:arms.map(arm=>({tag:arm.tag,bind:arm.bind,body:arm.body}))};
    }
    if(!wildcard)fail('scalar int match requires exhaustive wildcard/else');
    return {kind:'match',subject,arms:arms.map(arm=>({value:arm.value,body:arm.body}))};
  }
}
function resolveProgram(parsed) {
  const {modules,functions,classes=[]}=parsed;
  const slots=new Map(),exports=new Set(),symbolKinds=new Map(),classByName=new Map();
  const classTables=classes.map((cls,classIndex)=>{
    if(classByName.has(cls.name))fail('duplicate class '+cls.name);
    classByName.set(cls.name,classIndex);
    const methodSlots=new Map(),methodFamilies=new Set();
    cls.methods.forEach((method,methodIndex)=>{
      const key=method.name+'/'+method.params.length;
      if(methodSlots.has(key))fail('duplicate method name/arity '+cls.name+'.'+key);
      methodSlots.set(key,methodIndex);methodFamilies.add(method.name);
    });
    return {methodSlots,methodFamilies};
  });
  functions.forEach((fn,i)=>{
    const qualified=(fn.module===null?'@file/':'@module/'+fn.module+'/')+fn.name;
    const slot=qualified+'/'+fn.params.length;
    if(slots.has(slot)) fail('duplicate caller-visible arity '+slot);
    if(symbolKinds.has(qualified) && symbolKinds.get(qualified)!==fn.kind)
      fail('fnc and direct-call-only routine cannot share an exported name '+qualified);
    symbolKinds.set(qualified,fn.kind);
    slots.set(slot,i);
    if(fn.pub && fn.module===null) exports.add(fn.name);
  });
  modules.forEach(m=>{
    if(exports.has(m)) fail('module/function export conflict '+m);
    exports.add(m);
  });
  classes.forEach(cls=>{
    if(exports.has(cls.name))fail('class export conflicts with module/function '+cls.name);
    if(cls.pub)exports.add(cls.name);
  });
  let nodeCount=0,nextCaptureSlot=0;
  function resolvedType(expr,owner) {
    switch(expr.kind){
      case 'int':case 'neg':case 'binary':case 'capture':case 'match':return 'int';
      case 'bool':case 'not':case 'compare':case 'symbolCompare':return 'bool';
      case 'symbol':return 'symbol';
      case 'param':return owner.paramTypes?.[expr.index]??'int';
      case 'newClass':return 'class:'+expr.classIndex;
      case 'methodCall':case 'namedMethodCall':
        return classes[expr.classIndex].methods[expr.methodIndex].returnType;
      case 'call':case 'namedCall':return functions[expr.target].returnType??'int';
      case 'intrinsic': {
        const results={
          'Option.some':'option<int>','Option.none':'option<int>',
          'Option.is_some':'bool','Option.unwrap_or':'int',
          'Result.ok':'result<int,int>','Result.err':'result<int,int>',
          'Result.is_ok':'bool','Result.unwrap_or':'int','Result.unwrap_err_or':'int'
        };
        return results[expr.name];
      }
      case 'if':return resolvedType(expr.yes,owner);
      case 'adtMatch':return resolvedType(expr.arms[0].body,owner);
      default:fail('cannot infer resolved expression type '+expr.kind);
    }
  }
  function bindArguments(formals,sourceArgs,label,owner,depth,bindings){
    const byName=new Map(formals.map((name,index)=>[name,index]));
    const paramOrder=[],seen=new Set();let nextPositional=0,hasNamed=false;
    for(const arg of sourceArgs){
      let formal;
      if(arg.name===null)formal=nextPositional++;
      else{
        hasNamed=true;formal=byName.get(arg.name);
        if(formal===undefined)fail('unknown named argument '+arg.name+' for '+label);
      }
      if(formal>=formals.length)fail('call arity mismatch for '+label);
      if(seen.has(formal))fail('duplicate argument binding for '+formals[formal]);
      seen.add(formal);paramOrder.push(formal);
    }
    if(seen.size!==formals.length)fail('missing argument for '+label);
    return {
      args:sourceArgs.map(a=>resolve(a.expr,owner,depth+1,bindings)),
      paramOrder,hasNamed
    };
  }
  function resolve(expr,owner,depth=0,bindings=[]) {
    if(++nodeCount>MAX_TOKENS || depth>MAX_DEPTH) fail('IR node/depth budget exceeded');
    switch(expr.kind) {
      case 'int':case 'bool':case 'symbol':return expr;
      case 'newClass': {
        if(owner.ownerKind==='method')
          fail('class construction inside method body unsupported in convergence slice');
        const classIndex=classByName.get(expr.name);
        if(classIndex===undefined)fail('unknown class '+expr.name);
        if(expr.args.length!==0)fail('fieldless constructor arity mismatch for '+expr.name);
        return {kind:'newClass',classIndex};
      }
      case 'methodCall': {
        if(owner.ownerKind==='method')
          fail('nested method calls inside method body unsupported in convergence slice');
        const receiver=resolve(expr.receiver,owner,depth+1,bindings);
        const receiverType=resolvedType(receiver,owner);
        if(!receiverType.startsWith('class:'))fail('method receiver is not a class value');
        const classIndex=Number(receiverType.slice(6));
        const table=classTables[classIndex],cls=classes[classIndex];
        const methodIndex=table.methodSlots.get(expr.name+'/'+expr.args.length);
        if(methodIndex===undefined){
          if(table.methodFamilies.has(expr.name))
            fail('method arity mismatch for '+cls.name+'.'+expr.name);
          fail('unknown method '+cls.name+'.'+expr.name);
        }
        const method=cls.methods[methodIndex];
        if(!method.pub)fail('private method call '+cls.name+'.'+expr.name);
        const bound=bindArguments(method.params,expr.args,cls.name+'.'+expr.name,
          owner,depth,bindings);
        const base={classIndex,methodIndex,receiver,args:bound.args};
        return bound.hasNamed?{kind:'namedMethodCall',...base,paramOrder:bound.paramOrder}:
          {kind:'methodCall',...base};
      }
      case 'variable': {
        const captured=bindings.findLast(b=>b.name===expr.name);
        if(captured)return {kind:'capture',slot:captured.slot};
        const index=owner.params.indexOf(expr.name);
        if(index<0) fail('unresolved identifier '+expr.name);
        return {kind:'param',index};
      }
      case 'neg':case 'not':return {kind:expr.kind,inner:resolve(expr.inner,owner,depth+1,bindings)};
      case 'binary': return {kind:'binary',op:expr.op,left:resolve(expr.left,owner,depth+1,bindings),right:resolve(expr.right,owner,depth+1,bindings)};
      case 'compare': {
        const left=resolve(expr.left,owner,depth+1,bindings);
        const right=resolve(expr.right,owner,depth+1,bindings);
        const leftType=resolvedType(left,owner),rightType=resolvedType(right,owner);
        if(leftType==='symbol'||rightType==='symbol'){
          if(!['==','!='].includes(expr.op)||leftType!=='symbol'||rightType!=='symbol')
            fail('Symbol comparison requires Symbol ==/!= Symbol');
          return {kind:'symbolCompare',op:expr.op,left,right};
        }
        return {kind:'compare',op:expr.op,left,right};
      }
      case 'if': return {kind:'if',condition:resolve(expr.condition,owner,depth+1,bindings),
        yes:resolve(expr.yes,owner,depth+1,bindings),no:resolve(expr.no,owner,depth+1,bindings)};
      case 'call': {
        if(expr.qualifier==='Option'||expr.qualifier==='Result'){
          const key=expr.qualifier+'.'+expr.name;
          const signatures={
            'Option.some':[1,'option<int>'],
            'Option.none':[0,'option<int>'],
            'Option.is_some':[1,'bool'],
            'Option.unwrap_or':[2,'int'],
            'Result.ok':[1,'result<int,int>'],
            'Result.err':[1,'result<int,int>'],
            'Result.is_ok':[1,'bool'],
            'Result.unwrap_or':[2,'int'],
            'Result.unwrap_err_or':[2,'int']
          };
          const sig=signatures[key];
          if(!sig)fail('unknown portable constructor/intrinsic '+key);
          if(expr.args.some(a=>a.name!==null))
            fail('named arguments are unsupported for portable intrinsic '+key);
          if(expr.args.length!==sig[0])fail('intrinsic arity mismatch '+key);
          return {kind:'intrinsic',name:key,args:expr.args.map(a=>resolve(a.expr,owner,depth+1,bindings))};
        }
        if(owner.ownerKind==='method')
          fail('function calls inside method body unsupported in convergence slice');
        const mod=expr.qualifier===null?owner.module:expr.qualifier;
        if(mod!==null && !modules.includes(mod)) fail('unknown module '+mod);
        const key=(mod===null?'@file/':'@module/'+mod+'/')+expr.name;
        const target=slots.get(key+'/'+expr.args.length);
        if(target===undefined) {
          if(symbolKinds.has(key)) fail('call arity mismatch for '+key);
          fail('unresolved callable '+key);
        }
        if(expr.qualifier!==null && mod!==owner.module && !functions[target].pub) fail('private module member '+key);
        const bound=bindArguments(functions[target].params,expr.args,key,
          owner,depth,bindings);
        return bound.hasNamed?{kind:'namedCall',target,args:bound.args,paramOrder:bound.paramOrder}:
          {kind:'call',target,args:bound.args};
      }
      case 'match':
        if(owner.ownerKind==='method')
          fail('match inside method body unsupported in convergence slice');
        return {kind:'match',subject:resolve(expr.subject,owner,depth+1,bindings),
        arms:expr.arms.map(arm=>({value:arm.value,body:resolve(arm.body,owner,depth+1,bindings)}))};
      case 'adtMatch': {
        if(owner.ownerKind==='method')
          fail('ADT match inside method body unsupported in convergence slice');
        const subject=resolve(expr.subject,owner,depth+1,bindings);
        const arms=expr.arms.map(arm=>{
          let slot=null,scope=bindings;
          if(arm.bind!==null){
            if(owner.params.includes(arm.bind)||bindings.some(b=>b.name===arm.bind))
              fail('ADT payload binding shadows an existing name '+arm.bind);
            if(nextCaptureSlot>=MAX_TOKENS)fail('ADT capture slot budget exceeded');
            slot=nextCaptureSlot++;
            scope=[...bindings,{name:arm.bind,slot}];
          }
          return {tag:arm.tag,slot,body:resolve(arm.body,owner,depth+1,scope)};
        });
        return {kind:'adtMatch',adt:expr.adt,subject,arms};
      }
      default: fail('unsupported expression node');
    }
  }
  const resolved=functions.map(fn=>({...fn,body:resolve(fn.body,fn)}));
  const resolvedClasses=classes.map((cls,classIndex)=>({
    ...cls,
    methods:cls.methods.map(method=>({
      ...method,
      body:method.body===null?null:resolve(method.body,{
        ...method,module:null,ownerKind:'method',classIndex
      })
    }))
  }));
  const graph=resolved.map(()=>new Set());
  function inspect(expr,owner) {
    if(expr.kind==='call'||expr.kind==='namedCall') {
      graph[owner].add(expr.target);expr.args.forEach(a=>inspect(a,owner));
    } else if(expr.kind==='methodCall'||expr.kind==='namedMethodCall') {
      inspect(expr.receiver,owner);expr.args.forEach(a=>inspect(a,owner));
    } else if(expr.kind==='newClass') {
      // fieldless construction has no call-graph edge in this slice
    } else if(expr.kind==='intrinsic')expr.args.forEach(a=>inspect(a,owner));
    else if(expr.kind==='binary'||expr.kind==='compare'||expr.kind==='symbolCompare') {inspect(expr.left,owner);inspect(expr.right,owner);}
    else if(expr.kind==='if') {inspect(expr.condition,owner);inspect(expr.yes,owner);inspect(expr.no,owner);}
    else if(expr.kind==='neg'||expr.kind==='not') inspect(expr.inner,owner);
    else if(expr.kind==='match'||expr.kind==='adtMatch') {
      inspect(expr.subject,owner);expr.arms.forEach(a=>inspect(a.body,owner));
    }
  }
  resolved.forEach((f,i)=>inspect(f.body,i));
  // Conservative until there is a fuel/call-depth budget: matches may contain
  // conditional recursion, but rejecting cycles is safer than permitting an
  // unbounded JS stack explosion. This is NOT an Oreslang language restriction.
  const colors=new Uint8Array(resolved.length);
  function visit(i) {
    if(colors[i]===1) fail('recursive call graph unsupported pending fuel budget');
    if(colors[i]===2) return;
    colors[i]=1;for(const j of graph[i])visit(j); colors[i]=2;
  }
  resolved.forEach((_,i)=>visit(i));
  return {
    sourceNamespace:parsed.namespace,modules,functions:resolved,
    ...(resolvedClasses.length?{classes:resolvedClasses}:{})
  };
}
function emitProgram(program) {
  const out=[
    '// experimental Oreslang program-v2, provisional signed-64 integer model',
    'function _check(v){if(typeof v!=="bigint")throw new TypeError("Oreslang signed i64 BigInt required");if(v<-(1n<<63n)||v>(1n<<63n)-1n)throw new RangeError("ORES_I64_OVERFLOW: checked signed 64-bit overflow");return v;}',
    // Do not expose JS engine-specific "Division by zero" RangeError text as
    // an unclassified Oreslang guest failure. This is a provisional host-side
    // code, NOT the portable guest Error wire ABI or actor CONTROL signal.
    'function _rem(a,b){_check(a);_check(b);if(b===0n)throw new RangeError("ORES_I64_DIVISION_BY_ZERO: checked signed 64-bit remainder by zero");return _check(a%b);}'
  ];
  function emitExpr(expr,depth=0) {
    if(depth > MAX_DEPTH) fail('codegen depth exceeded');
    switch(expr.kind) {
      case 'int': return expr.value+'n';
      case 'symbol':return '_symbol('+JSON.stringify(expr.value)+')';
      case 'bool': return expr.value?'true':'false';
      case 'param':return '_p'+expr.index;
      case 'capture':return '_v'+expr.slot;
      // Oreslang checked signed-i64 arithmetic is not JS BigInt.asIntN
      // wrapping arithmetic. Check the computed result before returning.
      case 'neg':return '_check(-('+emitExpr(expr.inner,depth+1)+'))';
      case 'not':return '!('+emitExpr(expr.inner,depth+1)+')';
      case 'binary':
        if(expr.op==='%')return '_rem(('+emitExpr(expr.left,depth+1)+'),('+emitExpr(expr.right,depth+1)+'))';
        return '_check(('+emitExpr(expr.left,depth+1)+')'+expr.op+'('+emitExpr(expr.right,depth+1)+'))';
      case 'compare':return '(('+emitExpr(expr.left,depth+1)+')'+expr.op+'('+emitExpr(expr.right,depth+1)+'))';
      case 'symbolCompare': {
        const equal='_symboleq('+emitExpr(expr.left,depth+1)+','+
          emitExpr(expr.right,depth+1)+')';
        return expr.op==='=='?equal:'!('+equal+')';
      }
      case 'if':return '(('+emitExpr(expr.condition,depth+1)+')?('+
        emitExpr(expr.yes,depth+1)+'):('+emitExpr(expr.no,depth+1)+'))';
      case 'newClass':return 'new _class'+expr.classIndex+'()';
      case 'methodCall': {
        const method=program.classes[expr.classIndex].methods[expr.methodIndex];
        return '('+emitExpr(expr.receiver,depth+1)+')['+JSON.stringify(method.name)+']('+
          expr.args.map(x=>emitExpr(x,depth+1)).join(',')+')';
      }
      case 'namedMethodCall': {
        const method=program.classes[expr.classIndex].methods[expr.methodIndex];
        const declarations=['const _receiver='+emitExpr(expr.receiver,depth+1)+';'];
        expr.args.forEach((arg,i)=>declarations.push(
          'const _namedMethod'+i+'='+emitExpr(arg,depth+1)+';'));
        const formal=new Array(expr.args.length);
        expr.paramOrder.forEach((slot,i)=>{formal[slot]='_namedMethod'+i;});
        return '(()=>{'+declarations.join('')+'return _receiver['+
          JSON.stringify(method.name)+']('+formal.join(',')+');})()';
      }
      case 'call':return '_f'+expr.target+'('+expr.args.map(x=>emitExpr(x,depth+1)).join(',')+')';
      case 'namedCall': {
        const declarations=expr.args.map((arg,i)=>
          'const _named'+i+'='+emitExpr(arg,depth+1)+';');
        const formal=new Array(expr.args.length);
        expr.paramOrder.forEach((slot,i)=>{formal[slot]='_named'+i;});
        return '(()=>{'+declarations.join('')+'return _f'+expr.target+'('+
          formal.join(',')+');})()';
      }
      case 'intrinsic': {
        const funcs={
          'Option.some':'_some','Option.none':'_none',
          'Option.is_some':'_is_some','Option.unwrap_or':'_option_or',
          'Result.ok':'_ok','Result.err':'_err',
          'Result.is_ok':'_is_ok','Result.unwrap_or':'_result_or',
          'Result.unwrap_err_or':'_error_or'
        };
        const target=funcs[expr.name];
        if(!target)fail('unsupported portable intrinsic');
        return target+'('+expr.args.map(x=>emitExpr(x,depth+1)).join(',')+')';
      }
      case 'adtMatch': {
        const check=expr.adt==='option<int>'?'_checkoption':'_checkresult';
        const lines=['(()=>{const _subject='+emitExpr(expr.subject,depth+1)+';'+check+'(_subject);switch(_subject.kind){'];
        for(const arm of expr.arms){
          lines.push('case '+JSON.stringify(arm.tag)+':{');
          if(arm.slot!==null)lines.push('const _v'+arm.slot+'=_subject.value;');
          lines.push('return '+emitExpr(arm.body,depth+1)+';}');
        }
        lines.push('default:throw new TypeError("Oreslang ADT match illegal tag");}})()');
        return lines.join('');
      }
      case 'match': {
        // _subject is evaluated exactly once. A branch returns immediately,
        // so no fallthrough and unmatched arm expressions stay lazy.
        const lines=['(()=>{const _subject='+emitExpr(expr.subject,depth+1)+';switch(_subject){'];
        expr.arms.forEach(arm=>{
          lines.push(arm.value===null?'default:':'case '+arm.value+'n:');
          lines.push('return '+emitExpr(arm.body,depth+1)+';');
        });
        lines.push('}})()');
        return lines.join('');
      }
      default: fail('unsupported codegen expression');
    }
  }
  const classMethods=(program.classes??[]).flatMap(cls=>cls.methods);
  if(program.functions.some(fn=>fn.returnType==='bool'||fn.paramTypes?.includes('bool'))||
     classMethods.some(method=>method.returnType==='bool'||method.paramTypes.includes('bool')))
    out.push('function _checkbool(v){if(typeof v!=="boolean")throw new TypeError("Oreslang bool required");return v;}');
  function usesSymbol(expr) {
    switch(expr.kind) {
      case 'symbol':return true;
      case 'newClass':return false;
      case 'methodCall':case 'namedMethodCall':
        return usesSymbol(expr.receiver)||expr.args.some(usesSymbol);
      case 'call':case 'namedCall':case 'intrinsic':return expr.args.some(usesSymbol);
      case 'binary':case 'compare':case 'symbolCompare':
        return usesSymbol(expr.left)||usesSymbol(expr.right);
      case 'if':return usesSymbol(expr.condition)||usesSymbol(expr.yes)||usesSymbol(expr.no);
      case 'neg':case 'not':return usesSymbol(expr.inner);
      case 'match':case 'adtMatch':return usesSymbol(expr.subject)||
        expr.arms.some(arm=>usesSymbol(arm.body));
      default:return false;
    }
  }
  const hasSymbol=program.functions.some(fn=>fn.returnType==='symbol'||
    fn.paramTypes?.includes('symbol')||usesSymbol(fn.body))||
    classMethods.some(method=>method.returnType==='symbol'||
      method.paramTypes.includes('symbol')||(method.body!==null&&usesSymbol(method.body)));
  if(hasSymbol) {
    out.push(
      'const _symbolBrand=new WeakSet();',
      'function _symbolKind(k,n){const x=Object.create(null);Object.defineProperty(x,"kind",{value:k,enumerable:true});Object.defineProperty(x,"name",{value:n,enumerable:true});Object.freeze(x);_symbolBrand.add(x);return x;}',
      'function _symbol(n){return _symbolKind("PROCESS",n);}',
      'function _checksymbol(v){if(!v||typeof v!=="object"||!_symbolBrand.has(v)||Object.getPrototypeOf(v)!==null||!Object.isFrozen(v))throw new TypeError("Oreslang Symbol required");return v;}',
      'function _symboleq(a,b){_checksymbol(a);_checksymbol(b);return a.kind===b.kind&&a.name===b.name;}',
      'function _wireName(n,stable){if(typeof n!=="string"||n.length>1024)throw new TypeError("Oreslang Symbol wire name budget");for(let i=0;i<n.length;i++){const u=n.charCodeAt(i);if(u>=55296&&u<=56319){const lo=n.charCodeAt(i+1);if(!(lo>=56320&&lo<=57343))throw new TypeError("Oreslang Symbol wire UTF-16");i++;}else if(u>=56320&&u<=57343)throw new TypeError("Oreslang Symbol wire UTF-16");}if(n.normalize("NFC")!==n)throw new TypeError("Oreslang Symbol wire requires NFC");const bytes=new TextEncoder().encode(n).length;if(bytes<1||bytes>256)throw new TypeError("Oreslang Symbol wire byte budget");for(const ch of n){const cp=ch.codePointAt(0);if(cp<32||(cp>=127&&cp<=159)||/[\\p{Cf}\\p{Zl}\\p{Zp}]/u.test(ch)||cp===1564||cp===8206||cp===8207||(cp>=8234&&cp<=8238)||(cp>=8294&&cp<=8297))throw new TypeError("Oreslang Symbol wire forbidden Unicode");}if(stable&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(n))throw new TypeError("Oreslang Symbol wire stable UUID");return n;}',
      'function _wireDecode(v,policy="trusted"){if(policy!=="trusted"&&policy!=="untrusted-core")throw new TypeError("Oreslang Symbol wire policy");if(!v||typeof v!=="object"||Array.isArray(v)||(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null))throw new TypeError("Oreslang Symbol wire object");const keys=Reflect.ownKeys(v);if(keys.length!==2||!keys.includes("$symbol")||!keys.includes("name")||keys.some(k=>typeof k!=="string"))throw new TypeError("Oreslang Symbol wire shape");for(const k of ["$symbol","name"]){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!Object.hasOwn(d,"value")||!d.enumerable)throw new TypeError("Oreslang Symbol wire accessor/non-enumerable");}const kind=v.$symbol;if(kind!=="process"&&kind!=="stable")throw new TypeError("Oreslang Symbol wire kind");const name=_wireName(v.name,kind==="stable");if(policy==="untrusted-core"&&(kind!=="process"||!["ready","error","Symbol.iterator"].includes(name)))throw new TypeError("Oreslang Symbol wire denied");return _symbolKind(kind==="process"?"PROCESS":"STABLE",name);}',
      'function _wireEncode(v){const s=_checksymbol(v);const x=Object.create(null);Object.defineProperty(x,"$symbol",{value:s.kind==="PROCESS"?"process":"stable",enumerable:true});Object.defineProperty(x,"name",{value:s.name,enumerable:true});return Object.freeze(x);}',
      'const _symbolWireV1=Object.freeze({encode:_wireEncode,decode:_wireDecode});'
    );
  }
  // Intrinsics may be nested entirely within an int-returning function
  // without appearing in its public signature. Include helpers based on
  // both typed signatures and the entire already-validated expression DAG.
  function usesPortableRuntime(expr) {
    switch(expr.kind) {
      case 'intrinsic':return true;
      case 'newClass':return false;
      case 'methodCall':case 'namedMethodCall':
        return usesPortableRuntime(expr.receiver)||expr.args.some(usesPortableRuntime);
      case 'call':case 'namedCall':return expr.args.some(usesPortableRuntime);
      case 'binary':case 'compare':case 'symbolCompare':
        return usesPortableRuntime(expr.left)||usesPortableRuntime(expr.right);
      case 'if':return usesPortableRuntime(expr.condition)||
        usesPortableRuntime(expr.yes)||usesPortableRuntime(expr.no);
      case 'neg':case 'not':return usesPortableRuntime(expr.inner);
      case 'match':return usesPortableRuntime(expr.subject)||
        expr.arms.some(arm=>usesPortableRuntime(arm.body));
      case 'adtMatch':return true;
      default:return false;
    }
  }
  if(program.functions.some(fn=>['option<int>','result<int,int>'].includes(fn.returnType)||
      fn.paramTypes?.some(t=>['option<int>','result<int,int>'].includes(t))||
      usesPortableRuntime(fn.body))||
     classMethods.some(method=>['option<int>','result<int,int>'].includes(method.returnType)||
      method.paramTypes.some(t=>['option<int>','result<int,int>'].includes(t))||
      (method.body!==null&&usesPortableRuntime(method.body)))) {
    out.push(
      'function _tag(k,v){const x=Object.create(null);Object.defineProperty(x,"kind",{value:k,enumerable:true});Object.defineProperty(x,"value",{value:v,enumerable:true});return Object.freeze(x);}',
      'function _checktag(x,types){if(!x||typeof x!=="object"||Object.getPrototypeOf(x)!==null||!Object.isFrozen(x))throw new TypeError("Oreslang tagged value required");const keys=Reflect.ownKeys(x);if(keys.length!==2||!keys.includes("kind")||!keys.includes("value"))throw new TypeError("Oreslang tagged value shape required");const kd=Object.getOwnPropertyDescriptor(x,"kind"),vd=Object.getOwnPropertyDescriptor(x,"value");if(!kd||!vd||!Object.hasOwn(kd,"value")||!Object.hasOwn(vd,"value")||!kd.enumerable||!vd.enumerable||!types.includes(kd.value))throw new TypeError("Oreslang tagged value type required");if(kd.value==="None"){if(vd.value!==null)throw new TypeError("Oreslang None payload must be null");}else _check(vd.value);return x;}',
      'function _checkoption(v){return _checktag(v,["Some","None"]);}',
      'function _checkresult(v){return _checktag(v,["Ok","Err"]);}',
      'function _some(v){return _tag("Some",_check(v));}',
      'function _none(){return _tag("None",null);}',
      'function _ok(v){return _tag("Ok",_check(v));}',
      'function _err(v){return _tag("Err",_check(v));}',
      'function _is_some(v){return _checkoption(v).kind==="Some";}',
      'function _is_ok(v){return _checkresult(v).kind==="Ok";}',
      'function _option_or(v,d){_check(d);const x=_checkoption(v);return x.kind==="Some"?x.value:d;}',
      'function _result_or(v,d){_check(d);const x=_checkresult(v);return x.kind==="Ok"?x.value:d;}',
      'function _error_or(v,d){_check(d);const x=_checkresult(v);return x.kind==="Err"?x.value:d;}'
    );
  }
  (program.classes??[]).forEach((cls,classIndex)=>{
    const local='_class'+classIndex;
    out.push('class '+local+' {','#oresBrand=1;',
      'constructor(..._args){if(new.target!=='+local+')throw new TypeError("unsupported class derivation");if(_args.length!==0)throw new TypeError("constructor arity mismatch");Object.preventExtensions(this);}');
    const families=new Map();
    cls.methods.forEach((method,methodIndex)=>{
      if(!method.pub)return;
      if(!families.has(method.name))families.set(method.name,[]);
      families.get(method.name).push(methodIndex);
    });
    for(const [name,indices] of families){
      out.push(JSON.stringify(name)+'(..._args){',
        'if(this===null||(typeof this!=="object"&&typeof this!=="function")||!(#oresBrand in this))throw new TypeError("invalid Oreslang receiver");',
        'switch(_args.length){');
      for(const methodIndex of indices){
        const method=cls.methods[methodIndex];
        out.push('case '+method.params.length+':{');
        method.params.forEach((_,i)=>{
          const type=method.paramTypes[i];
          const check={int:'_check',bool:'_checkbool',symbol:'_checksymbol',
            'option<int>':'_checkoption','result<int,int>':'_checkresult'}[type];
          if(!check)fail('unsupported method parameter type');
          out.push('const _p'+i+'=_args['+i+'];'+check+'(_p'+i+');');
        });
        out.push(method.returnType==='void'?'return;':'return '+emitExpr(method.body)+';','}');
      }
      out.push('default:throw new TypeError("method arity mismatch");','}','}');
    }
    out.push('}','Object.freeze('+local+'.prototype);','Object.freeze('+local+');');
  });
  program.functions.forEach((fn,i)=>{
    const params=fn.params.map((_,j)=>'_p'+j);
    out.push('function _f'+i+'('+params.join(',')+'){');
    params.forEach((p,j)=>{
      const type=fn.paramTypes?.[j]??'int';
      const check={int:'_check',bool:'_checkbool',symbol:'_checksymbol',
        'option<int>':'_checkoption','result<int,int>':'_checkresult'}[type];
      if(!check)fail('unsupported portable parameter type');
      out.push(check+'('+p+');');
    });
    out.push('return '+emitExpr(fn.body)+';','}');
  });
  let dispatcherNumber=0;
  function exportCallable(indices) {
    // Always use the public arity dispatcher, even for one overload.
    const name='_dispatch'+(dispatcherNumber++);
    out.push('function '+name+'(..._args){switch(_args.length){');
    for(const i of indices) {
      out.push('case '+program.functions[i].params.length+':return _f'+i+'(..._args);');
    }
    out.push('default:throw new TypeError("Oreslang overload arity mismatch");}}');
    return name;
  }
  function publicGroups(module) {
    const result=new Map();
    program.functions.forEach((fn,i)=>{
      if(fn.module===module && fn.pub) {
        if(!result.has(fn.name))result.set(fn.name,[]);
        result.get(fn.name).push(i);
      }
    });
    return result;
  }
  program.modules.forEach((module,i)=>{
    out.push('const _module'+i+'=Object.create(null);');
    for(const [name,indices] of publicGroups(module)) {
      const callable=exportCallable(indices);
      out.push('Object.defineProperty(_module'+i+','+JSON.stringify(name)+',{value:'+callable+',enumerable:true,configurable:false,writable:false});');
    }
    out.push('Object.freeze(_module'+i+');');
    out.push('export { _module'+i+' as '+JSON.stringify(module)+' };');
  });
  for(const [name,indices] of publicGroups(null)) {
    out.push('export { '+exportCallable(indices)+' as '+JSON.stringify(name)+' };');
  }
  (program.classes??[]).forEach((cls,i)=>{
    if(cls.pub)out.push('export { _class'+i+' as '+JSON.stringify(cls.name)+' };');
  });
  if(hasSymbol)out.push('export { _symbolWireV1 as "@oreslang/symbol-wire-v1" };');
  return out.join('\n')+'\n';
}
export function compileToProgramIRV2(source) {
  const program=resolveProgram(new Parser(tokenize(source)).parse());
  return validateProgramIRV2({
    schemaVersion:PROGRAM_IR_VERSION,
    dialect:PROGRAM_IR_DIALECT,
    integerModel:PROGRAM_IR_INT_MODEL,
    ...program
  });
}
export function compileProgramIRV2(ir) {
  return emitProgram(validateProgramIRV2(ir));
}
export function compileProgramV2(source) {
  return emitProgram(compileToProgramIRV2(source));
}
export function checkProgramV2(source) {
  compileProgramV2(source);
  return true;
}
