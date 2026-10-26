param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [ValidateSet('win-x64', 'win-arm64')][string]$Rid = 'win-x64'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$verifyPe = Join-Path $PSScriptRoot 'assert-native-pe.ps1'
& $verifyPe -Binary $Binary -Rid $Rid
$fullPath = (Resolve-Path -LiteralPath $Binary).Path
$directory = Split-Path -Parent $fullPath
$managedSidecars = @(Get-ChildItem -LiteralPath $directory -File | Where-Object {
    $_.Extension -ieq '.dll' -or
    $_.Name -ilike '*.deps.json' -or
    $_.Name -ilike '*.runtimeconfig.json'
})
if ($managedSidecars.Count -gt 0) {
    throw ("Managed publish sidecar(s) forbidden in Native AOT release: " +
        (($managedSidecars | ForEach-Object { $_.Name }) -join ', '))
}
Write-Host "Verified strict Native AOT release layout: $fullPath"
