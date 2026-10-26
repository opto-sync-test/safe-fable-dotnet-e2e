param(
    [Parameter(Mandatory = $true)][string]$Source,
    [ValidateSet('win-x64', 'win-arm64')][string]$Rid = 'win-x64',
    [string]$Output = 'artifacts/apps'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sourcePath = (Resolve-Path $Source).Path
$generated = Join-Path $root 'artifacts/generated/OresGenerated.dll'
$compilerOut = Join-Path $root "artifacts/compiler/$Rid"
$checkNative = Join-Path $root 'verification/assert-native-release.ps1'
$publishOut = Join-Path $root "$Output/$Rid"
New-Item -ItemType Directory -Force (Split-Path -Parent $generated) | Out-Null
# Stale artifacts from a previous successful publish must not satisfy the checks
# after a failed or incomplete build.
$exe = Join-Path $compilerOut 'oresnet.exe'
$binary = Join-Path $publishOut 'oreslang-app.exe'
Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $binary -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $generated -Force -ErrorAction SilentlyContinue

# Only the native compiler executable is run in the distributed build path.
dotnet publish (Join-Path $root 'compiler/Ores.Net.Compiler/Ores.Net.Compiler.csproj') -c Release -r $Rid -o $compilerOut -warnaserror
if ($LASTEXITCODE -ne 0) { throw 'Native compiler publish failed' }

if (-not (Test-Path -LiteralPath $exe)) { throw 'Native compiler executable was not published' }
& $checkNative -Binary $exe -Rid $Rid
& $exe compile $sourcePath --out $generated
if ($LASTEXITCODE -ne 0) { throw 'Oreslang-to-CIL compilation failed' }

# A previous publish of this same host project may have used another
# generated assembly (for example hello.ores versus native.add). Clean its
# intermediate artifacts so the AOT linker cannot reuse stale compiled IL.
$hostProject = Join-Path $root 'host/Ores.Net.NativeHost/Ores.Net.NativeHost.csproj'
dotnet clean $hostProject -c Release -r $Rid "-p:GeneratedAssembly=$generated"
if ($LASTEXITCODE -ne 0) { throw 'Native AOT host clean failed' }
dotnet publish $hostProject -c Release -r $Rid -o $publishOut "-p:GeneratedAssembly=$generated" -warnaserror
if ($LASTEXITCODE -ne 0) { throw 'Native AOT publish failed' }

if (-not (Test-Path -LiteralPath $binary)) { throw "Expected native executable is missing: $binary" }
& $checkNative -Binary $binary -Rid $Rid
if (Test-Path (Join-Path $publishOut 'OresGenerated.dll')) {
    throw 'Managed generated assembly was copied to native publish output'
}
if (Test-Path (Join-Path $publishOut 'oreslang-app.runtimeconfig.json')) {
    throw 'Framework-dependent runtime configuration unexpectedly found'
}
Write-Host "Native AOT executable: $binary"
