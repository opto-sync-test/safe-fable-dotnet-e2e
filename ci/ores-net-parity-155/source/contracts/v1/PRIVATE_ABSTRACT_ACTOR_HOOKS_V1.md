# Oreslang private abstract and actor hook contract v1
Status: pre-1.0 normative source contract, 2026-10-16.

## Inheritance and dispatch
- `private abstract` is a virtual override-only **instance** slot, not a private
  nonvirtual method. Concrete subclasses must supply exactly one implementation.
- Selection uses the existing instance namespace and (name, value arity).
  The *originating* private abstract superclass retains invocation authority,
  even through intermediate concrete or abstract redeclarations.
- Code lexically belonging to that superclass may invoke its slot and must
  dispatch virtually to the concrete implementation. Subclass and external
  user code may not call it, take/capture/bind a method value, or publish it
  with a wider visibility; indirect and dynamic invocation are equally denied.
- A descendant cannot launder a different parameter, return, ownership,
  mutability, structural or suspension contract into the original slot.
  Substituted inherited generic signatures must be checked before admission.
  A backend without sound generic substitution must reject those overrides.
- Multiple independent inherited origins of one private abstract selector
  must be diagnosed, never selected by traversal order. Ordinary unrelated
  private methods retain their original visibility rules.

## Receiver normalization
- `method(self, T x)` and `method(T x)` are the same instance selector.
  `method(self)` has arity zero. A leading `self` is typed intrinsically as
  `Self`; it is NOT passed as a value argument or copied per actor.
- `method(mut self, T x)` uses existing mutable receiver loan semantics.
  Legacy `method(mut self)(T x)` and `method(self Type)(T x)`
  remain valid where already supported; mixed spellings do not overload.
- This normalization applies to ordinary classes and actors. A static
  callable cannot declare `self`. Receiver markers must be first.
- Explicit `self` never authorizes implicit capture in a lexical lambda.

## Actor ingress
- Canonical source hook: `receive(self, ActorMail<T> mail): void`, equivalently
  `receive(ActorMail<T> mail): void`. There is exactly one mailbox parameter.
- `receive` and `on_start` are runtime-owned extension points: code in an
  actor cannot invoke them directly, through `super`, an alias, a callback,
  reflective/dynamic member access, or a stored method value.
- Trusted mailbox admission, actor scheduler and ownership enforcement must
  precede runtime invocation. The hidden superclass / runtime is the
  invoker. No method-name-only Java reflection exception exists.
- The restricted LLVM bootstrap `on_message(int)` is a legacy *subset* and
  is **not** the canonical `ActorMail<T>` ingress ABI. No backend may
  silently relabel `on_message(int)` as tested `receive(ActorMail<T>)`.

## Minimum source conformance cases
P1 positive: `private abstract` base, concrete private override, base invokes
and obtains overridden result via virtual dispatch.
P2 positive: actor mailbox delivery invokes `receive` with both receiver
spellings and identical arity/actor code-sharing semantics.
N1 negative: derived direct call, `super`, external call, bound capture,
and runtime/dynamic member invocation.
N2 negative: public widening, intermediate redeclaration laundering,
signature incompatibility, multiple conflicting origins and unresolved slot.
N3 negative: actor direct `receive`, direct `on_start`, callback capture,
duplicate spellings and malformed/static `self`.
N4 negative: unsupported generic substitutions must fail closed.

## Backend evidence gate
- Java/Graal: real source compilation, type checker, JVM guest execution,
  Native Image AOT/hybrid, negative diagnostics and actor concurrency tests.
- LLVM: real frontend->native guest and diagnostics; do not count the
  restricted `on_message(int)` fixture as canonical hook support.
- Wasm: pinned LLVM compiler source/sha -> Wasm guest execution for positive
  claims; rejected source must produce no emitted IR or guest artifact.
- .NET: real structured compiler -> .NET guest / Native AOT for positive
  claims; partial scalar-only compiler must explicitly reject unsupported
  class and actor hook syntax.
- Forge: real native compiler/CTest guest for positive claims; scalar
  bootstrap must diagnose unsupported methods and emit no artifact.
- Test evidence must bind to an exact HEAD commit and identical Git source
  tree SHA. Green reference-model tests or a successful runner probe do
  not establish compiled guest parity. Never export private source into
  an unapproved CI destination; protected-policy review and pinned repo
  identity are prerequisites.
