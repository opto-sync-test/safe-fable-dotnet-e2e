# Nominal enum overload parity — version 1

**Normative target, not an assertion of executable parity.** This file is
intentionally byte-identical in the five Oreslang source repositories:
`oreslang-source.java`, `oreslang-source.llvm`, `oreslang-source.net`,
`oreslang-source.wasm`, and `oreslang-source.forge`.

## Compile-time admission and selection

- Resolve lexical scope, callable kind (module function, routine, static
  function, or ordinary instance method), exact name and explicit arity first.
  Hidden receivers are never an argument in the overload key.
- Same-name, same-arity declarations may coexist only when all candidate
  pairs differ at a corresponding parameter position by **distinct, eligible,
  compiler-resolved nominal enum declaration IDs**. Other corresponding
  positions must have exactly identical canonical declared types.
- An eligible enum is closed and has only nullary cases or primitive-scalar
  payload fields. Enum cases, tags, shapes and payload values never
  distinguish overloads. Unknown, erased, union, generic, structural,
  borrowed, actor or unverified imported identities are not proof.
- Select the callable once, at compile time, from verified enum identities.
  Validate *every* argument separately against the selected declaration.
  Primitive identity must preserve signedness and source width when those
  affect canonical type identity: `f32` is not evidence for `f64`,
  and erased `FLOAT`/ `INT` are not evidence for exact `f64`/ `i64`.
- The call-site binding stores an immutable, declared nominal signature slot
  and declaration provenance. Dynamic virtual dispatch may substitute only
  an override of that exact slot. A different enum parameter is a different
  overload, not a replacement. No runtime argument-based overload search.
- Actors retain isolated message entrypoints and their existing ownership,
  effects, visibility, capability and single-flight restrictions. Method
  overloading must not expose runtime-only actor hooks to user calls.

## Required differential fixtures

1. Positive: different arities; `pick(Color, bool)` vs
   `pick(Mode, bool)`, where `Color` and `Mode` are distinct eligible
   enum declarations.
2. Positive: Base contributes both signatures, Child replaces only the
   `Color` signature, Grandchild replaces only `Mode`; calls bound
   through a Base receiver invoke the correct subclass implementation.
3. Positive: the same enum with two different case values still selects
   the **same** compile-time overload.
4. Negative: `pick(int)` vs `pick(string)`; duplicate enum IDs;
   variant-only case differences; ambiguous diamonds; invalid override
   visibility; actors accessed through ordinary method calls.
5. Negative: `Unknown`, forged enum IDs, incompatible scalar arguments,
   `f32` vs `f64`, `i8` vs `i64`, malformed AST bindings,
   dynamic tag/payload selection and cross-code-image identity mismatch.

## Release gate (all five)

Do not enable any positive syntax on a backend without a production parser,
typechecker, immutable call-site binding and executable runtime/AOT virtual
slot table that all agree on canonical IDs. Bootstrap subsets **must
reject unsupported constructs** with a nonzero diagnostic and must not
publish an executable artifact. The Wasm backend inherits source-language
semantics from an independently pinned, real LLVM compiler; host-only policy
tests or Wasm binary validation are not compiler semantic parity.

Evidence must contain exact source Git commit/tree, compiler binary identity,
actual executed source fixtures, native/JVM or managed test results, and
negative-admission diagnostics. A CI job that executes zero steps and a
policy-only helper test do not satisfy this gate.
