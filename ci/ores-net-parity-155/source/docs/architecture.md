# Oreslang .NET design: strict Native AOT

## Non-negotiable execution constraints

- **Runtime JIT: forbidden.** No interpreter-based language execution or managed JIT fallback in shipping applications.
- **Runtime dynamic loading: forbidden.** No `Assembly.Load*`, `Reflection.Emit`, `DynamicMethod`, runtime-generated CIL, runtime C# compilation or new code via plugins.
- **Static linking surface:** compiler emits `OresGenerated.dll` at build time; host references `Oreslang.Generated.OresProgram.Run` statically so trimming retains the method.
- **Distribution:** both compiler CLI and application must be Native AOT-produced Windows executables. `dotnet build` produces intermediate managed assemblies but **is not a release**.
- **Compile target:** Windows x64 first, Windows ARM64 after target-specific validation. Native AOT builds require platform-appropriate toolchains.
- **Transitive AOT:** every runtime dependency must survive Native AOT analysis and functional testing. No suppressing warnings without a documented proof.

## Language to CIL lowering

Current parser supports a fixed i64 arithmetic main function. CIL emitter walks its bounded AST to produce `ldc.i8`, `add.ovf`, `sub.ovf`, `mul.ovf`, `div`, and `ret` instructions. The runtime host converts checked overflow and division exceptions to exit code 70. No runtime compiler or reflection invocation occurs.

Upcoming typed OresIR should represent actor send/await, ownership moves, borrows, error handling, and cooperation points explicitly before mapping to CIL. Generated signatures must remain statically discoverable at link/publish time.

## Actors and OresVM

The current `ActorMailbox` copies untyped bytes, caps queue depth and byte usage, serializes mutation under a lock, and rejects mismatched actor generations. **It is not a full OresVM runtime.** In particular, it provides neither per-actor managed heaps, authenticated capabilities, scheduler domains, isolation proof, supervision, futures nor hot reload.

Production integration requires a versioned wire protocol with serializer contracts, immutable envelope metadata, actor-group permits, and a runtime scheduler. Plan for CLR GC interactions honestly: managed Native AOT retains GC; private actor arenas may require native allocations and a carefully validated lifetime protocol.

## Hot code replacement under strict AOT

Do **not** attempt JIT fallback or `Assembly.LoadFile` to maintain Oreslang hot reload semantics. Instead compile and stage a new native generation, start a new process, validate contracts and health, hand off routing through an explicit proxy, and drain the old process. Inter-generation messages must carry versioned serialization formats and authenticated generations.

## Interoperability with sibling backends

Java/GraalVM, LLVM, Forge and .NET must share the normative language specification, error semantics, Result wire format, symbol handling, ownership rules and conformance suites. This new backend is an implementation target, not permission to fork Oreslang syntax.

## Build prerequisites

Use .NET 10 with Native AOT support. Windows compilation needs Visual Studio C++ build tools. Native AOT does not use LLVM here: the .NET toolchain performs ahead-of-time native compilation of statically linked CIL.

References: https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/ and https://www.nuget.org/packages/Mono.Cecil/0.11.6 .
