param(
    [Parameter(Mandatory = $true)][string]$Compiler,
    [Parameter(Mandatory = $true)][string]$ValidSource
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$binary = (Resolve-Path -LiteralPath $Compiler).Path
$source = (Resolve-Path -LiteralPath $ValidSource).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("oresnet-cli-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work | Out-Null

function Assert-Exit {
    param([int]$Expected, [string[]]$Arguments, [string]$Case)
    # Prevent intentional nonzero native process codes from terminating PowerShell.
    $output = (& $binary @Arguments 2>&1 | Out-String)
    $code = $LASTEXITCODE
    if ($code -ne $Expected) {
        throw "${Case}: expected exit $Expected, got $code. Output: $output"
    }
}

Push-Location -LiteralPath $work
try {
    Assert-Exit -Expected 2 -Arguments @() -Case 'no args'
    Assert-Exit -Expected 2 -Arguments @('compile', $source) -Case 'missing --out'
    $out = Join-Path $work 'OresGenerated.dll'
    Assert-Exit -Expected 2 -Arguments @('check', $source, '--out', $out) -Case 'check must not compile'
    if (Test-Path -LiteralPath $out) {
        throw 'Validation-only check unexpectedly published a compiled assembly'
    }
    Assert-Exit -Expected 2 -Arguments @('compile', $source, '--other', 'ignored') -Case 'unknown flag'
    Assert-Exit -Expected 0 -Arguments @('check', $source) -Case 'valid check'
    # A successful source/typed-IR check must not become an executable result.
    # Exactly the separate compile command may publish OresGenerated.dll.
    if ((Get-ChildItem -LiteralPath $work -Force | Measure-Object).Count -ne 0) {
        throw 'Validation-only check modified the artifact working directory'
    }

    $oversize = Join-Path $work 'oversize.ores'
    [IO.File]::WriteAllBytes($oversize, [byte[]]::new(1048577))
    Assert-Exit -Expected 1 -Arguments @('check', $oversize) -Case 'oversize'

    $badUtf8 = Join-Path $work 'invalid-utf8.ores'
    [IO.File]::WriteAllBytes($badUtf8, [byte[]]@(0xFF, 0xFE, 0xFF))
    Assert-Exit -Expected 1 -Arguments @('check', $badUtf8) -Case 'invalid UTF8'

    $invalidSource = Join-Path $work 'invalid.ores'
    [IO.File]::WriteAllText($invalidSource, 'fnc main():int {return 1 @ 3;}')
    Assert-Exit -Expected 1 -Arguments @('compile', $invalidSource, '--out', $out) -Case 'invalid syntax'
    if (Test-Path -LiteralPath $out) {
        throw 'Invalid source unexpectedly generated CIL'
    }

    Assert-Exit -Expected 0 -Arguments @('compile', $source, '--out', $out) -Case 'valid compile'
    if (-not (Test-Path -LiteralPath $out)) {
        throw 'Valid source failed to produce assembly'
    }
    # Compile output alone is not an executed Native AOT guest. The separate
    # Windows Native AOT workflow must publish and RUN oreslang-app.exe.
    if ((Get-Item -LiteralPath $out).Length -le 0) {
        throw 'Compiled assembly is empty'
    }
    Write-Host 'Native compiler CLI negative and positive tests passed'
}
finally {
    Pop-Location
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
