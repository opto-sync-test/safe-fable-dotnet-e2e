param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [ValidateSet('win-x64', 'win-arm64')][string]$Rid = 'win-x64'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$verify = Join-Path $PSScriptRoot 'assert-native-pe.ps1'
$original = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Binary).Path)
& $verify -Binary $Binary -Rid $Rid
$pe = [BitConverter]::ToInt32($original, 0x3c)
$optional = $pe + 24
$coffCharacteristics = $pe + 22
$clrDirectory = $optional + 112 + 14 * 8
$work = Join-Path ([IO.Path]::GetTempPath()) ('ores-net-pe-negative-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null

function Expect-Rejection {
    param([string]$Name, [scriptblock]$Change)
    $copy = [byte[]]$original.Clone()
    & $Change $copy
    $file = Join-Path $work ($Name + '.exe')
    [IO.File]::WriteAllBytes($file, $copy)
    $rejected = $false
    try {
        & $verify -Binary $file -Rid $Rid | Out-Null
    } catch {
        $rejected = $true
    }
    if (-not $rejected) { throw "Verifier accepted invalid PE fixture: $Name" }
}

try {
    Expect-Rejection 'missing-mz' { param($buffer) $buffer[0] = 0 }
    Expect-Rejection 'no-sections' {
        param($buffer)
        $buffer[$pe + 6] = 0
        $buffer[$pe + 7] = 0
    }
    Expect-Rejection 'dll-flag' {
        param($buffer)
        $buffer[$coffCharacteristics + 1] =
            [byte]($buffer[$coffCharacteristics + 1] -bor 0x20)
    }
    Expect-Rejection 'missing-directories' {
        param($buffer)
        [Array]::Copy([BitConverter]::GetBytes([uint32]0), 0,
            $buffer, $optional + 108, 4)
    }
    Expect-Rejection 'forged-clr-header' {
        param($buffer)
        [Array]::Copy([BitConverter]::GetBytes([uint32]1), 0,
            $buffer, $clrDirectory, 4)
    }
    Write-Host 'Native PE verifier negative fixtures passed'
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
