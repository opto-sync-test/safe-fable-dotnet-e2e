param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [ValidateSet('win-x64', 'win-arm64')][string]$Rid = 'win-x64'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Reject PE files containing a CLR/COM descriptor. A managed .NET apphost is
# a native launcher, but can still depend on a managed DLL and installed runtime.
# Verify the standalone Native AOT image, not just its .exe extension.
$resolved = (Resolve-Path -LiteralPath $Binary).Path
$stream = [System.IO.File]::Open($resolved, [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
$reader = [System.IO.BinaryReader]::new($stream)
try {
    if ($stream.Length -lt 512) { throw 'Truncated PE image' }
    $stream.Position = 0
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'Missing DOS MZ signature' }
    $stream.Position = 0x3C
    $pe = [long]$reader.ReadUInt32()
    if ($pe -lt 0x40 -or $pe -gt ($stream.Length - 256)) {
        throw 'Invalid PE header offset'
    }
    $stream.Position = $pe
    if ($reader.ReadUInt32() -ne 0x00004550) { throw 'Missing PE signature' }
    $coffStart = $stream.Position
    $machine = $reader.ReadUInt16()
    $expected = if ($Rid -eq 'win-x64') { 0x8664 } else { 0xAA64 }
    if ($machine -ne $expected) {
        throw ("Unexpected PE machine 0x{0:X4}; expected 0x{1:X4}" -f $machine, $expected)
    }
    $stream.Position = $coffStart + 2
    $sectionCount = $reader.ReadUInt16()
    if ($sectionCount -lt 1 -or $sectionCount -gt 96) {
        throw 'Invalid PE section count'
    }
    $stream.Position = $coffStart + 16
    $optionalSize = $reader.ReadUInt16()
    $characteristics = $reader.ReadUInt16()
    if (($characteristics -band 0x0002) -eq 0 -or
        ($characteristics -band 0x2000) -ne 0) {
        throw 'Expected an executable image, not a DLL or non-executable'
    }
    $optionalStart = $coffStart + 20
    if ($optionalSize -lt 232 -or ($optionalStart + $optionalSize) -gt $stream.Length) {
        throw 'Invalid PE32+ optional header'
    }
    $stream.Position = $optionalStart
    if ($reader.ReadUInt16() -ne 0x20B) {
        throw 'Expected 64-bit PE32+ executable'
    }
    # NumberOfRvaAndSizes is at offset 108 for PE32+. Requiring
    # directory 14 to exist prevents a crafted truncated image from
    # appearing to have no CLR descriptor just because the field is absent.
    $stream.Position = $optionalStart + 108
    if ($reader.ReadUInt32() -lt 15) {
        throw 'PE has no CLR data-directory entry'
    }
    # PE32+ data directories start 112 bytes into the optional header.
    # Directory index 14 is IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR.
    $stream.Position = $optionalStart + 112 + (14 * 8)
    $clrRva = $reader.ReadUInt32()
    $clrSize = $reader.ReadUInt32()
    if ($clrRva -ne 0 -or $clrSize -ne 0) {
        throw 'Found CLR metadata header: not a strict Native AOT image'
    }
}
finally {
    $reader.Dispose()
    $stream.Dispose()
}
$sidecar = [System.IO.Path]::ChangeExtension($resolved, '.runtimeconfig.json')
if (Test-Path -LiteralPath $sidecar) {
    throw "Managed runtime configuration present: $sidecar"
}
Write-Host "Validated Native AOT PE ($Rid): $resolved"
