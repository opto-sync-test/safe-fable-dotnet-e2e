param(
    [ValidateSet('win-x64', 'linux-x64')][string]$Rid = 'win-x64'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path -Parent $PSScriptRoot
$projects = @(
    (Join-Path $root 'compiler/Ores.Net.Compiler/Ores.Net.Compiler.csproj'),
    (Join-Path $root 'host/Ores.Net.NativeHost/Ores.Net.NativeHost.csproj')
)

function Assert-Gate {
    param([string]$Project, [string]$Label, [bool]$Success, [string[]]$Overrides)
    $properties = [ordered]@{
        PublishAot = 'true'
        SelfContained = 'true'
        RuntimeIdentifier = $Rid
        TargetFramework = 'net10.0'
    }
    foreach ($override in $Overrides) {
        $parts = $override.Split('=', 2)
        if ($parts.Count -ne 2 -or -not $properties.Contains($parts[0])) {
            throw "Unexpected test override: $override"
        }
        $properties[$parts[0]] = $parts[1]
    }
    $arguments = @('msbuild', $Project, '-target:VerifyStrictNativeAotPublish')
    foreach ($name in $properties.Keys) {
        $arguments += ('-property:{0}={1}' -f $name, $properties[$name])
    }
    $null = & dotnet @arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if (($exitCode -eq 0) -ne $Success) {
        throw "$([IO.Path]::GetFileName($Project)) ${Label}: unexpected exit $exitCode"
    }
}

foreach ($project in $projects) {
    Assert-Gate -Project $project -Label 'valid Native AOT' -Success $true -Overrides @()
    Assert-Gate -Project $project -Label 'managed/JIT publish' -Success $false -Overrides @('PublishAot=false')
    Assert-Gate -Project $project -Label 'framework-dependent publish' -Success $false -Overrides @('SelfContained=false')
    Assert-Gate -Project $project -Label 'unsupported target RID' -Success $false -Overrides @('RuntimeIdentifier=osx-arm64')
    Assert-Gate -Project $project -Label 'wrong framework' -Success $false -Overrides @('TargetFramework=net9.0')
}
# Expected negative MSBuild invocations leave LASTEXITCODE nonzero. Reset it
# only after every expected outcome was checked, so a successful gate does not
# fail its enclosing Actions PowerShell step.
$global:LASTEXITCODE = 0
Write-Host 'Strict Native AOT MSBuild release-gate checks passed'
