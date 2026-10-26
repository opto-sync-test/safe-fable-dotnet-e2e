param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-fA-F0-9]{40}$')]
    [string]$ExpectedCommit
)

# Exact-source manual or ephemeral self-hosted Windows x64 AOT verification.
# No cross-organization checkout tokens or secret parameters are required.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $IsWindows) {
    throw 'Windows x64 Native AOT verification requires a Windows host'
}
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
$working = $null
try {
    function Invoke-RequiredNative([string]$Description, [scriptblock]$Action) {
        & $Action
        if ($LASTEXITCODE -ne 0) {
            throw "$Description failed with exit code $LASTEXITCODE"
        }
    }

    Invoke-RequiredNative 'Git checkout identity' {
        $script:ActualHead = (git rev-parse --verify HEAD).Trim()
    }
    if ($ActualHead -ine $ExpectedCommit) {
        throw "Wrong source commit: expected $ExpectedCommit, got $ActualHead"
    }
    # Do not let untracked .cs/.props/.targets, generated input assemblies,
    # or other checkout-local build inputs influence the reviewed source.
    # Git status respects .gitignore for normal SDK obj/bin/artifact outputs.
    Invoke-RequiredNative 'Git checkout cleanliness' {
        $script:CheckoutChanges = @(git status --porcelain=v1 --untracked-files=all)
    }
    if ($CheckoutChanges.Count -gt 0 -and ($CheckoutChanges -join '').Trim() -ne '') {
        throw ('Checkout contains modified or untracked files: ' +
            ($CheckoutChanges -join '; '))
    }

    Invoke-RequiredNative '.NET SDK information' {
        dotnet --info
    }
    Invoke-RequiredNative '.NET SDK version' {
        $script:SdkVersion = (dotnet --version).Trim()
    }
    if ($SdkVersion -notmatch '^10\.') {
        throw "This release gate requires .NET 10 SDK; got $SdkVersion"
    }

    $testProject = 'verification/Ores.Net.Tests/Ores.Net.Tests.csproj'
    Invoke-RequiredNative 'Managed compiler and CFG test build' {
        dotnet build $testProject -c Release -warnaserror
    }
    Invoke-RequiredNative 'Managed compiler, SSA, CFG and CIL regression execution' {
        dotnet run --project $testProject -c Release --no-build
    }

    # Publishes the native oresnet compiler, executes it to produce verified
    # OresGenerated.dll, and links the native host. It refuses stale
    # distributables and managed runtime sidecars.
    & ./scripts/publish-windows.ps1 -Source examples/hello.ores -Rid win-x64
    $nativeCompiler = Join-Path $root 'artifacts/compiler/win-x64/oresnet.exe'
    $nativeApp = Join-Path $root 'artifacts/apps/win-x64/oreslang-app.exe'
    & ./verification/assert-native-release.ps1 -Binary $nativeCompiler -Rid win-x64
    & ./verification/assert-native-release.ps1 -Binary $nativeApp -Rid win-x64
    $arithmetic = & $nativeApp
    if ($LASTEXITCODE -ne 0 -or ($arithmetic | Out-String).Trim() -cne '14') {
        throw "Native arithmetic fixture must return 14; got '$arithmetic'"
    }
    & ./verification/assert-native-compiler-cli.ps1 -Compiler $nativeCompiler -ValidSource examples/hello.ores
    & ./verification/assert-native-arithmetic.ps1 -Rid win-x64

    # Regenerate this exact SHA's CFG fixture in a fresh directory. Clean
    # cached host references before static Native AOT linking, so the
    # previous arithmetic fixture cannot satisfy the CFG assertion.
    $working = Join-Path ([IO.Path]::GetTempPath()) (
        'ores-net-aot-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $working -Force | Out-Null
    $generated = Join-Path $working 'OresGenerated.dll'
    $hostProject = 'host/Ores.Net.NativeHost/Ores.Net.NativeHost.csproj'
    $cfgOutput = Join-Path $working 'native'
    Invoke-RequiredNative 'Verified CFG fixture generation' {
        dotnet run --project verification/Ores.Net.CfgFixtures/Ores.Net.CfgFixtures.csproj -c Release -- $generated
    }
    if (-not (Test-Path -LiteralPath $generated -PathType Leaf)) {
        throw 'Verified CFG fixture generator did not create an assembly'
    }
    Invoke-RequiredNative 'Clean Native AOT host before CFG relink' {
        dotnet clean $hostProject -c Release -r win-x64 "-p:GeneratedAssembly=$generated"
    }
    Invoke-RequiredNative 'Native AOT compile of CFG branch/loop fixture' {
        dotnet publish $hostProject -c Release -r win-x64 -o $cfgOutput "-p:GeneratedAssembly=$generated" -warnaserror
    }
    $cfgApp = Join-Path $cfgOutput 'oreslang-app.exe'
    & ./verification/assert-native-release.ps1 -Binary $cfgApp -Rid win-x64
    $cfgResult = & $cfgApp
    if ($LASTEXITCODE -ne 0 -or ($cfgResult | Out-String).Trim() -cne '2211') {
        throw "Native CFG atomic-swap fixture must return 2211; got '$cfgResult'"
    }

    Write-Host "VERIFIED: exact commit $ActualHead"
    Write-Host "VERIFIED: .NET SDK $SdkVersion"
    Write-Host 'VERIFIED: managed tests, strict Native AOT compiler and application'
    Write-Host 'VERIFIED: native arithmetic=14; native CFG atomic swap=2211'
}
finally {
    if ($null -ne $working -and (Test-Path -LiteralPath $working)) {
        Remove-Item -LiteralPath $working -Recurse -Force
    }
    Pop-Location
}
