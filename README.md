# SAFE/Fable + OptoSync E2E

This fixture proves the supported C# and F# OptoSync binding in a real .NET
web stack:

- an F# Giraffe server reconciles JSON through the pinned native `syncer.c`
  engine and serves the compiled browser application;
- Fable 5 compiles the browser entry point from F# to JavaScript;
- a real service worker persists mutations in IndexedDB, drains independent
  lanes concurrently, retains failed batches for replay, and publishes merged
  server state back to every controlled window;
- the .NET background contract simulates a disconnected first attempt, then
  replays mobile and desktop lanes concurrently through the F# SDK facade.

The service worker uses browser Background Sync when available and also wakes
on explicit messages and the browser `online` event. It does not pretend a
service worker can hold a process open indefinitely; durable queue state is
what keeps the bidirectional protocol alive across worker termination.

## Immutable OptoSync boundary

`vendor/opto-sync-clients` is a git submodule pinned by
`opto-sync-pin.json`. Its nested `syncer.c` submodule pins the exact native
engine. CI fails before compiling if either gitlink differs from the declared
commit.

## Run locally

Build a shared native library for your platform and expose its absolute path:

```sh
cc -shared -fPIC -O2 \
  -I vendor/opto-sync-clients/syncer.c/core/include \
  vendor/opto-sync-clients/syncer.c/core/src/syncer.c \
  vendor/opto-sync-clients/syncer.c/core/src/yyjson.c \
  -o /tmp/libsyncer-safe-fable.so
export OPTO_SYNC_NATIVE_LIBRARY=/tmp/libsyncer-safe-fable.so
```

On macOS, use `-dynamiclib` and a `.dylib` output. Then:

```sh
dotnet tool restore
dotnet fable src/Client/Client.fsproj --outDir public/fable --lang javascript
dotnet build src/Server/Server.fsproj --configuration Release
dotnet run --project src/Server/Server.fsproj --configuration Release -- --self-test
dotnet run --project src/Server/Server.fsproj --configuration Release -- --urls http://127.0.0.1:5078
```

The live server exposes `GET /health`, `POST /sync`, the Fable bundle, and the
durable service worker. GitHub Actions compiles every layer and exercises both
the background replay and the live HTTP merge path.
