# Oreslang method receiver and lexical capture contract — v1

Status: normative target contract; **not** proof of implementation parity.
Applies to Java/GraalVM, LLVM, .NET, Forge and Wasm. A backend that cannot
prove a feature must reject it explicitly, with a compile-time diagnostic.
Never interpret unsupported syntax as the older scalar subset.

## 1. Receiver and overload identity

Within a class or actor these declarations have **identical** identity:

```ores
receive(self, Mail m): void { ... }
receive(Mail m): void { ... }
```

They are not two overloads. Declaring both must produce a duplicate method
slot error. `self` is a receiver marker, never a value parameter, never a
change to `arity`, never a per-instance method allocation. `foo(self)`
is the zero-argument spelling of `foo()`, and legacy `foo(self Foo)(int x)`
remains the same slot as `foo(self, int x)` and `foo(int x)`.
`mut self` changes receiver borrowing rules, not overload selection;
it never grants an actor direct state mutation or mailbox dispatch authority.

Overloads are selected by owner, instance/static namespace, name and
value-parameter count. Receiver spelling, generics, return type, effects,
mutability and ordinary argument types are not distinguishing keys.
Inheritance and overrides reuse the inherited slot with checked contracts.

A compiled class has exactly one method implementation and one immutable
effective dispatch table per linked code image (subject to normal
specialization). Each instance carries class identity and independent
state, not cloned methods, closures, or method tables. An invocation binds
its receiver to `self` in a *per-call* frame; actor execution remains
single-flight per instance. Explicit bound callback values, if supported,
are separate from and cannot redefine the method storage model.

## 2. Lambda capture policies

Canonical brackets and spelling:

* `|x| -> ...`: ordinary lexical captures except **no implicit self**.
* `nlex |x| -> ...`: captures no outer values.
* `lex[a,b] |x| -> ...`: only listed outer bindings visible; allowlist.
* `nlex[a,b] |x| -> ...`: all otherwise-legal bindings except named exclusions;
  denylist, still **no implicit self**.
* `lex[self] |x| -> ...`: makes receiver name eligible for resolution **only**;
  borrow/actor rules still apply. It may therefore be rejected for borrowed
  actor/class receivers in escaping closures.
* `nlex[self] |x| -> ...`: self excluded, ordinary eligible locals captured.

Lists are binding identifiers, not arbitrary expressions. Unknown, duplicate,
rebound/ambiguous, nonlexical or parameter-shadowed capture names fail at
compile time. Capture resolution must use the exact lexical binding, not merely
a string name or an ambient class namespace. Nested closures may never recover
an excluded binding. The checked set of **actually used** captures determines
the closure payload; don't retain entire method frames, unused `self`, or
unrelated mutable values by accident. Move/borrow/effect rules apply to every
capture. A callback cannot leak its temporary actor-state loan.

## 3. Actor state callback target (not implied by parser support)

```ores
self.handle_state(nlex[self] critical |state| -> {
    state.count = state.count + 1;
    self.process(m);  // COMPILE ERROR: self is out of scope
});
```

`critical` denotes exclusive state-write admission granted by the sealed
state intrinsic; it does **not** confer receiver capture authority. State
loans do not escape or survive suspension/await/select/cancellation.
A backend without typed state/effect/loan lowering must reject this form,
not substitute a scalar mutation or an unprotected callback.

## 4. Evidence gates

1. Parse+type check all positive and negative cases in both receiver spellings.
2. Reject duplicates in both declaration orders and across legacy syntax.
3. Test 1,024+ class/actor instances with same method body identity but
   independent state; verify inheritance and no per-instance method code.
4. Validate `lex[]` / `nlex[]`, unknown/shadowed names, nested closures,
   mutable captures, borrow lifetime, nonescaping callbacks and actor `self`.
5. Verify real native execution + no-IR rejection for LLVM, compiler/JVM and
   Native Image for Java, Native AOT for .NET, native code for Forge, and
   compiler-generated Wasm with a pinned real LLVM compiler and exact provenance.
6. Record exact source Git tree SHA and compiler artifact hashes. Static source
   review, skipped tests and no-run CI never count as compiler parity.
7. Never transfer private source to another GitHub organization without explicit
   reviewed destination authorization and visibility checks.

## 5. Current rollout boundary

* Java/GraalVM: implementation is on draft PR #1087, unverified CI.
* LLVM: restricted scalar actor `on_message` supports optional receiver
  marker on parity-gate branch; general class methods and lambda captures
  remain unsupported.
* .NET and Forge: scalar bootstrap; reject method and lambda policies.
* Wasm: uses the real native LLVM compiler and its restrictions; no independent
  source-language implementation of these features.

This is a phased migration. Cross-backend parity is **NOT ACHIEVED** until
all required positive code executes and negative cases reject as specified.
