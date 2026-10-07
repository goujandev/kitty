# Build-only: ship the pinned Handy speech pack and CPU runtime in the installer.
# Generated resources and cached archives are not source files.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Tauri's child shell can inherit another PowerShell edition's module path.
# Resolve the utility module from this running edition for hash/network/zip tools.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = [IO.File]::ReadAllText((Join-Path $workspace 'src-tauri/src/dictation.rs'))

function Read-Pin([string]$Name) {
    $match = [regex]::Match($source, ('const ' + $Name + ': &str = "([^"]+)";'))
    if (!$match.Success) { throw "Missing dictation pin: $Name" }
    return $match.Groups[1].Value
}

function Assert-WorkspacePath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (!$absolute.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Generated path leaves the workspace: $absolute"
    }
    # Never follow a junction or symbolic link when replacing generated files.
    $current = $absolute
    while ($current -and $current -ne $workspace) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Generated path contains a link: $current"
            }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    return $absolute
}

function Remove-Generated([string]$Path) {
    $absolute = Assert-WorkspacePath $Path
    if (Test-Path -LiteralPath $absolute) {
        foreach ($entry in Get-ChildItem -LiteralPath $absolute -Recurse -Force) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Generated directory contains a link: $($entry.FullName)"
            }
        }
        Remove-Item -LiteralPath $absolute -Recurse -Force
    }
}

function File-Hash([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$modelName = Read-Pin 'MODEL_NAME'
$runtimeName = Read-Pin 'RUNTIME_NAME'
$marker = Read-Pin 'PACK_MARKER'
$modelList = [regex]::Match($source, 'const MODEL_FILES: &\[&str\] = &\[([\s\S]*?)\];')
if (!$modelList.Success) { throw 'Missing dictation model file list.' }
$modelFiles = @([regex]::Matches($modelList.Groups[1].Value, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
$runtimeFiles = @('onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'LICENSE', 'ThirdPartyNotices.txt')
foreach ($name in @($modelName, $runtimeName, $marker) + $modelFiles + $runtimeFiles) {
    if ($name -notmatch '^[a-zA-Z0-9_.-]+$' -or $name -in @('.', '..')) { throw "Unsafe component name: $name" }
}
$cache = Assert-WorkspacePath (Join-Path $workspace 'target/dictation-pack-downloads')
$resources = Assert-WorkspacePath (Join-Path $workspace 'src-tauri/resources')
$target = Assert-WorkspacePath (Join-Path $resources 'dictation')
$stage = Assert-WorkspacePath (Join-Path $resources ('.dictation-staging-' + [guid]::NewGuid().ToString('N')))
$backup = Assert-WorkspacePath (Join-Path $resources ('.dictation-backup-' + [guid]::NewGuid().ToString('N')))
New-Item -ItemType Directory -Path $cache, $resources -Force | Out-Null

function Get-Archive([string]$Name, [string]$Url, [string]$Hash, [long]$MaxBytes) {
    $destination = Assert-WorkspacePath (Join-Path $cache $Name)
    if ((Test-Path -LiteralPath $destination) -and (File-Hash $destination) -eq $Hash) { return $destination }
    $smoke = Assert-WorkspacePath (Join-Path $workspace ('target/dictation-smoke/' + $Name))
    if ((Test-Path -LiteralPath $smoke) -and (File-Hash $smoke) -eq $Hash) {
        Copy-Item -LiteralPath $smoke -Destination $destination -Force
        return $destination
    }
    $temporary = Assert-WorkspacePath ($destination + '.download')
    try {
        Write-Host "Downloading pinned dictation asset: $Name"
        Invoke-WebRequest -Uri $Url -OutFile $temporary -UseBasicParsing -TimeoutSec 600
        if ((Get-Item -LiteralPath $temporary).Length -gt $MaxBytes -or (File-Hash $temporary) -ne $Hash) {
            throw "Dictation archive failed its size or SHA256 check: $Name"
        }
        Move-Item -LiteralPath $temporary -Destination $destination -Force
        return $destination
    } finally { Remove-Generated $temporary }
}

$modelHash = Read-Pin 'MODEL_HASH'
$runtimeHash = Read-Pin 'RUNTIME_HASH'
$modelArchive = Get-Archive 'model.tar.gz' (Read-Pin 'MODEL_URL') $modelHash 180000000
$runtimeArchive = Get-Archive 'runtime.zip' (Read-Pin 'RUNTIME_URL') $runtimeHash 100000000
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
    # Extract only exact known regular tar entries. Unselected metadata and paths
    # cannot create links, parents, or other files in our staging directory.
    $entries = @($modelFiles | ForEach-Object { "$modelName/$_" })
    $listing = @(& tar -tvzf $modelArchive -- @entries)
    if ($LASTEXITCODE -ne 0 -or $listing.Count -ne $entries.Count -or @($listing | Where-Object { !$_.StartsWith('-') }).Count -gt 0) {
        throw 'The model archive must contain each allowlisted file exactly once as a regular file.'
    }
    & tar -xzf $modelArchive -C $stage -- @entries
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the pinned model archive.' }
    $modelDirectory = Join-Path $stage $modelName
    foreach ($name in $modelFiles) {
        $file = Get-Item -LiteralPath (Join-Path $modelDirectory $name)
        if ($file.PSIsContainer -or $file.Length -eq 0 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Invalid extracted model component: $name"
        }
    }
    if ((Get-ChildItem -LiteralPath $modelDirectory -File | Measure-Object Length -Sum).Sum -gt 260000000) {
        throw 'Extracted model exceeds its size limit.'
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $runtimeDirectory = Join-Path $stage $runtimeName
    New-Item -ItemType Directory -Path $runtimeDirectory | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($runtimeArchive)
    try {
        [long]$total = 0
        foreach ($name in $runtimeFiles) {
            $path = if ($name.EndsWith('.dll')) { "$runtimeName/lib/$name" } else { "$runtimeName/$name" }
            $matches = @($zip.Entries | Where-Object { $_.FullName -ceq $path })
            if ($matches.Count -ne 1) { throw "Missing or duplicate runtime component: $name" }
            $entry = $matches[0]
            $kind = ($entry.ExternalAttributes -shr 16) -band 61440
            $total += $entry.Length
            if ($kind -notin @(0, 32768) -or $entry.Length -le 0 -or $total -gt 100000000) {
                throw "Invalid runtime component: $name"
            }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $runtimeDirectory $name))
        }
    } finally { $zip.Dispose() }
    [IO.File]::WriteAllText((Join-Path $modelDirectory $marker), $modelHash)
    [IO.File]::WriteAllText((Join-Path $runtimeDirectory $marker), $runtimeHash)
    [IO.File]::WriteAllText((Join-Path $modelDirectory 'LICENSE.txt'),
        [IO.File]::ReadAllText((Join-Path $workspace 'docs/licenses/Dictation-LICENSES.txt')))

    # Compare freshly extracted, hash-pinned contents before reusing resources.
    $files = @(Get-ChildItem -LiteralPath $stage -Recurse -File)
    $unchanged = Test-Path -LiteralPath $target
    if ($unchanged) {
        $unchanged = @(Get-ChildItem -LiteralPath $target -Recurse -File).Count -eq $files.Count
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($stage.Length + 1)
            $existing = Assert-WorkspacePath (Join-Path $target $relative)
            if (!(Test-Path -LiteralPath $existing) -or (File-Hash $existing) -ne (File-Hash $file.FullName)) {
                $unchanged = $false
                break
            }
        }
    }
    if (!$unchanged) {
        if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath (Assert-WorkspacePath $target) -Destination $backup }
        try { Move-Item -LiteralPath (Assert-WorkspacePath $stage) -Destination $target }
        catch {
            if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath (Assert-WorkspacePath $backup) -Destination $target }
            throw
        }
        Remove-Generated $backup
    }
    $size = (Get-ChildItem -LiteralPath $target -Recurse -File | Measure-Object Length -Sum).Sum
    Write-Host "Verified bundled dictation pack: $($files.Count) files, $size bytes."
} finally { Remove-Generated $stage }

# ONNX Runtime imports these release x64 CRT libraries. Ship the redistributable
# copies supplied by Visual Studio, so a clean Windows account needs no VC setup.
$crtNames = @('msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'Bundling dictation requires Visual Studio C++ redistributables (vswhere was not found).' }
$installations = @(& $vswhere -all -products '*' -property installationPath)
if ($LASTEXITCODE -ne 0) { throw 'Could not discover Visual Studio C++ redistributables.' }
$candidates = @(foreach ($installation in $installations) {
    $redist = Join-Path $installation 'VC/Redist/MSVC'
    if (!(Test-Path -LiteralPath $redist)) { continue }
    foreach ($version in Get-ChildItem -LiteralPath $redist -Directory) {
        if ($version.Name -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { continue }
        $x64 = Join-Path $version.FullName 'x64'
        if (!(Test-Path -LiteralPath $x64)) { continue }
        foreach ($crt in Get-ChildItem -LiteralPath $x64 -Directory -Filter 'Microsoft.VC*.CRT') {
            if (@($crtNames | Where-Object { !(Test-Path -LiteralPath (Join-Path $crt.FullName $_) -PathType Leaf) }).Count -eq 0) {
                [pscustomobject]@{ Version = [version]$version.Name; Directory = $crt.FullName }
            }
        }
    }
})
$selected = $candidates | Sort-Object Version -Descending | Select-Object -First 1
if (!$selected) { throw 'Install the Visual Studio C++ x64 release redistributables: all four ONNX Runtime CRT dependencies are required.' }
$crtTarget = Assert-WorkspacePath (Join-Path $resources 'vc-runtime')
$crtStage = Assert-WorkspacePath (Join-Path $resources ('.vc-runtime-staging-' + [guid]::NewGuid().ToString('N')))
$crtBackup = Assert-WorkspacePath (Join-Path $resources ('.vc-runtime-backup-' + [guid]::NewGuid().ToString('N')))
New-Item -ItemType Directory -Path $crtStage | Out-Null
try {
    foreach ($name in $crtNames) {
        $inputFile = Join-Path $selected.Directory $name
        $signature = Get-AuthenticodeSignature -LiteralPath $inputFile
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
            throw "CRT dependency must carry a valid Microsoft Authenticode signature: $name"
        }
        $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($inputFile))
        try {
            if ($reader.ReadUInt16() -ne 23117) { throw "Invalid CRT executable: $name" }
            $reader.BaseStream.Position = 60
            $header = $reader.ReadInt32()
            if ($header -lt 64 -or $header -gt ($reader.BaseStream.Length - 6)) { throw "Invalid CRT PE header: $name" }
            $reader.BaseStream.Position = $header
            if ($reader.ReadUInt32() -ne 17744 -or $reader.ReadUInt16() -ne 34404) { throw "CRT dependency must be Windows x64: $name" }
        } finally { $reader.Dispose() }
        $destination = Join-Path $crtStage $name
        Copy-Item -LiteralPath $inputFile -Destination $destination
        if ((File-Hash $inputFile) -ne (File-Hash $destination)) { throw "CRT copy failed its integrity check: $name" }
    }
    $same = (Test-Path -LiteralPath $crtTarget) -and @(Get-ChildItem -LiteralPath $crtTarget -File).Count -eq $crtNames.Count
    foreach ($name in $crtNames) {
        $existing = Assert-WorkspacePath (Join-Path $crtTarget $name)
        if (!(Test-Path -LiteralPath $existing) -or (File-Hash $existing) -ne (File-Hash (Join-Path $crtStage $name))) { $same = $false; break }
    }
    if (!$same) {
        if (Test-Path -LiteralPath $crtTarget) { Move-Item -LiteralPath (Assert-WorkspacePath $crtTarget) -Destination $crtBackup }
        try { Move-Item -LiteralPath (Assert-WorkspacePath $crtStage) -Destination $crtTarget }
        catch {
            if (Test-Path -LiteralPath $crtBackup) { Move-Item -LiteralPath (Assert-WorkspacePath $crtBackup) -Destination $crtTarget }
            throw
        }
        Remove-Generated $crtBackup
    }
    $crtSize = (Get-ChildItem -LiteralPath $crtTarget -File | Measure-Object Length -Sum).Sum
    Write-Host "Verified bundled Microsoft x64 CRT $($selected.Version): $($crtNames.Count) files, $crtSize bytes."
} finally { Remove-Generated $crtStage }
