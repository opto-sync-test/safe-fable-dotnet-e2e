param(
    [ValidateSet('win-x64')][string]$Rid = 'win-x64'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $root 'artifacts/compiler/win-x64/oresnet.exe'
$hostProject = Join-Path $root 'host/Ores.Net.NativeHost/Ores.Net.NativeHost.csproj'
$peVerifier = Join-Path $root 'verification/assert-native-pe.ps1'
$testRoot = Join-Path $root 'artifacts/native-negative/win-x64'
if (-not (Test-Path -LiteralPath $compiler)) {
    throw 'Publish the native compiler before running arithmetic tests'
}
& $peVerifier -Binary $compiler -Rid $Rid

$cases = @(
    @{ Name='overflow'; Expected='overflow'; Source='examples/overflow.ores' },
    @{ Name='division-by-zero'; Expected='float result lowering'; Source='examples/division-by-zero.ores' },
    @{ Name='division-overflow'; Expected='float result lowering'; Source='examples/division-overflow.ores' }
)

foreach ($case in $cases) {
    $folder = Join-Path $testRoot $case.Name
    $generatedFolder = Join-Path $folder 'generated'
    $outputFolder = Join-Path $folder 'published'
    New-Item -ItemType Directory -Force -Path $generatedFolder | Out-Null
    $generated = Join-Path $generatedFolder 'OresGenerated.dll'
    $source = Join-Path $root $case.Source
    Remove-Item -LiteralPath $generated -Force -ErrorAction SilentlyContinue
    $binary = Join-Path $outputFolder 'oreslang-app.exe'
    Remove-Item -LiteralPath $binary -Force -ErrorAction SilentlyContinue

    $compileText = (& $compiler compile $source --out $generated 2>&1 | Out-String)
    if ($case.Name -like 'division-*') {
        if ($LASTEXITCODE -ne 1 -or $compileText -notmatch [regex]::Escape($case.Expected) -or
            (Test-Path -LiteralPath $generated)) {
            throw "Source division must be diagnosed before CIL publication: $compileText"
        }
        Write-Host "Verified source division admission rejection: $($case.Name)"
        continue
    }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $generated)) {
        throw "Failed to emit CIL for $($case.Name)"
    }

    # Isolate each scenario's generated assembly from cached host outputs.
    # Cleaning before publish prevents stale OresGenerated.dll CIL being linked.
    dotnet clean $hostProject -c Release -r $Rid "-p:GeneratedAssembly=$generated"
    if ($LASTEXITCODE -ne 0) { throw "Host clean failed for $($case.Name)" }
    dotnet publish $hostProject -c Release -r $Rid -o $outputFolder "-p:GeneratedAssembly=$generated" -warnaserror
    if ($LASTEXITCODE -ne 0) { throw "Native AOT publish failed for $($case.Name)" }
    & $peVerifier -Binary $binary -Rid $Rid
    if (Test-Path -LiteralPath (Join-Path $outputFolder 'OresGenerated.dll')) {
        throw "Managed CIL leaked into native release for $($case.Name)"
    }

    $text = (& $binary 2>&1 | Out-String)
    $exit = $LASTEXITCODE
    if ($exit -ne 70 -or $text -notmatch [regex]::Escape($case.Expected)) {
        throw "$($case.Name): expected exit 70 and '$($case.Expected)', got exit $exit and '$text'"
    }
    Write-Host "Verified Native AOT negative case: $($case.Name)"
}

# Each negative native fixture intentionally exits 70. Reset the shell's
# process status only after every expected failure has been checked, so the
# enclosing GitHub Actions pwsh step cannot falsely report a failed test.
$global:LASTEXITCODE = 0
Write-Host 'All Native AOT checked-arithmetic negative fixtures passed'
