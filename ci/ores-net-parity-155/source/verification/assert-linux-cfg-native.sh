#!/usr/bin/env bash
# Managed test tools only generate CIL at build time; the resulting application
# must be compiled to a self-contained Native AOT ELF before executing it.
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
command -v dotnet >/dev/null || { echo "dotnet SDK is required" >&2; exit 2; }
command -v file >/dev/null || { echo "file is required" >&2; exit 2; }

work="$(mktemp -d "${TMPDIR:-/tmp}/ores-net-cfg-native.XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT
generated="$work/OresGenerated.dll"
output="$work/published"
project="host/Ores.Net.NativeHost/Ores.Net.NativeHost.csproj"

# Do not allow a previously published arithmetic example to satisfy the
# CFG execution check. The generated assembly comes from this exact build.
dotnet run --project verification/Ores.Net.CfgFixtures/Ores.Net.CfgFixtures.csproj \
  -c Release -- "$generated"
test -s "$generated" || { echo "CFG compiler emitted no assembly" >&2; exit 1; }

# Clean the Native AOT host between the arithmetic example and this different
# static dependency: host source has the same OresGenerated assembly identity.
dotnet clean "$project" -c Release -r linux-x64 "-p:GeneratedAssembly=$generated"
dotnet publish "$project" -c Release -r linux-x64 -o "$output" \
  "-p:GeneratedAssembly=$generated" -warnaserror

app="$output/oreslang-app"
test -x "$app" || { echo "CFG Native AOT executable missing" >&2; exit 1; }
file "$app" | grep -q 'ELF 64-bit' || { echo "CFG output is not ELF" >&2; exit 1; }
test ! -e "$output/oreslang-app.runtimeconfig.json" || {
  echo "CFG published a managed runtimeconfig sidecar" >&2; exit 1;
}
test ! -e "$output/oreslang-app.deps.json" || {
  echo "CFG published a managed deps sidecar" >&2; exit 1;
}
test ! -e "$output/OresGenerated.dll" || {
  echo "CFG published the managed generated assembly" >&2; exit 1;
}

# A genuine executable run (not a managed Cecil interpreter) must perform one
# loop backedge and a simultaneous swap of two typed CFG parameters.
set +e
result="$("$app")"
status=$?
set -e
if [[ "$status" -ne 0 || "$result" != '2211' ]]; then
  printf 'CFG Native AOT mismatch: exit=%s output=%q expected=2211\n' \
    "$status" "$result" >&2
  exit 1
fi
echo "Verified native Linux CFG loop/atomic swap: $result"
