# Self-contained .NET 10 exact-source CLI smoke (no cross-org source copies).
# Run from repository root after the Release compiler project has built.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$compiler = 'compiler/Ores.Net.Compiler/Ores.Net.Compiler.csproj'
$scalar = 'contracts/scalar/v1/fixtures/literal-42.ores'
if (-not (Test-Path $scalar)) { throw 'Missing known scalar conformance fixture' }

function Invoke-Facts([string]$kind, [string]$path) {
    $lines = & dotnet run --no-build -c Release --project $compiler -- $kind $path
    if ($LASTEXITCODE -ne 0) { throw "Fact CLI $kind returned $LASTEXITCODE" }
    $doc = (($lines -join "`n") | ConvertFrom-Json)
    if ($doc.version -ne 'ores-static-facts/v0') { throw 'Wrong static-facts version' }
    $bytes = [IO.File]::ReadAllBytes((Resolve-Path $path).Path)
    $sha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    if ($doc.unit -cne "sha256:$sha") { throw 'Source digest is not exact UTF-8 bytes' }
    if (@($doc.procedures).Count -ne 1 -or $doc.procedures[0].id -ne '__root__.main/0') {
        throw 'Expected one canonical main/0 function'
    }
    foreach ($key in @('edges', 'taint_sources', 'flows', 'sinks', 'permission_checks')) {
        if (@($doc.$key).Count -ne 0) { throw "Unproved effect facts were emitted: $key" }
    }
    return $doc
}

$scalarFacts = Invoke-Facts 'static-facts' $scalar
if (@($scalarFacts.procedures[0].loops).Count -ne 0) {
    throw 'Production scalar frontend invented loop effects'
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
# A persistent self-hosted runner must not retain source-derived fixtures
# if any assertion fails halfway through the negative-test sequence.
$structured = $null
$withBom = $null
$wrongExt = $null
try {
    $structured = Join-Path $tempRoot ('net-static-facts-structured-' + [Guid]::NewGuid().ToString('N') + '.ores')
    $source = "fnc main():int{let int x=0;while x<2{x=x+1;}return x;}"
    [IO.File]::WriteAllText($structured, $source, [Text.UTF8Encoding]::new($false))
    $structuredFacts = Invoke-Facts 'static-facts-structured' $structured
    $loops = @($structuredFacts.procedures[0].loops)
    if ($loops.Count -ne 1 -or $loops[0].id -ne 'L1' -or
        $loops[0].exit -ne 'unknown' -or $loops[0].safepoint -ne $false) {
        throw 'Structured while loop lost unknown exit/safepoint status'
    }

    # The shipping executable subset does not allow loops, even if the
    # experimental structured checker understands them.
    & dotnet run --no-build -c Release --project $compiler -- static-facts $structured *> $null
    if ($LASTEXITCODE -eq 0) {
        throw 'Shipping scalar verifier accidentally accepted structured while'
    }

    # No strict admission profile exists for unsigned advisory facts.
    & dotnet run --no-build -c Release --project $compiler -- static-facts $scalar hard *> $null
    if ($LASTEXITCODE -ne 2) {
        throw "Unexpected strict-profile CLI result: $LASTEXITCODE"
    }

    $withBom = Join-Path $tempRoot ('net-static-facts-bom-' + [Guid]::NewGuid().ToString('N') + '.ores')
    $payload = [Text.Encoding]::UTF8.GetBytes('fnc main():int{return 42;}')
    $withBomBytes = [byte[]]::new(3 + $payload.Length)
    $withBomBytes[0] = 0xef
    $withBomBytes[1] = 0xbb
    $withBomBytes[2] = 0xbf
    [Array]::Copy($payload, 0, $withBomBytes, 3, $payload.Length)
    [IO.File]::WriteAllBytes($withBom, $withBomBytes)
    & dotnet run --no-build -c Release --project $compiler -- static-facts $withBom *> $null
    if ($LASTEXITCODE -eq 0) { throw 'BOM source was silently signed after stripping bytes' }

    # A source file in another format cannot be quietly relabelled and signed.
    $wrongExt = Join-Path $tempRoot ('net-static-facts-other-' + [Guid]::NewGuid().ToString('N') + '.txt')
    Copy-Item -LiteralPath $scalar -Destination $wrongExt -Force
    & dotnet run --no-build -c Release --project $compiler -- static-facts $wrongExt *> $null
    if ($LASTEXITCODE -eq 0) {
        throw 'Static facts accepted a source file without the .ores extension'
    }

    $global:LASTEXITCODE = 0  # expected failed negative executions
    Write-Host 'Oreslang .NET static-facts/v0 CLI, byte identity and fail-closed tests passed'
}
finally {
    foreach ($fixture in @($structured, $withBom, $wrongExt)) {
        if (-not [string]::IsNullOrWhiteSpace($fixture) -and
            (Test-Path -LiteralPath $fixture)) {
            Remove-Item -LiteralPath $fixture -Force
        }
    }
}
