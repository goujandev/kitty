param([Parameter(Mandatory=$true)][string]$PreviousInstaller, [Parameter(Mandatory=$true)][string]$NewInstaller)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Installed upgrade smoke is restricted to disposable GitHub-hosted Windows runners.'
}
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installDir = Join-Path $workspace 'target/installed-rebrand-smoke/app'
$dataDir = Join-Path $env:APPDATA 'dev.kitty.desktop'
$database = Join-Path $dataDir 'kitty.db'
if (Test-Path -LiteralPath $dataDir) { throw 'Runner already has app data; refusing to overwrite it.' }
$registry = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/Kitty'
if (Test-Path -LiteralPath $registry) { throw 'Runner already has an installation; refusing to overwrite it.' }

function Install-Checked([string]$Installer, [string]$Arguments) {
    $process = Start-Process -FilePath ([IO.Path]::GetFullPath($Installer)) -ArgumentList $Arguments -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Installer failed with exit $($process.ExitCode)." }
}
function Check-Startup([string]$Binary, [string]$Title) {
    $process = Start-Process -FilePath $Binary -WindowStyle Hidden -PassThru
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        do {
            Start-Sleep -Milliseconds 500
            $process.Refresh()
            if ($process.HasExited) { throw "$Title exited at startup ($($process.ExitCode))." }
            if ($process.MainWindowHandle -ne 0 -and $process.MainWindowTitle -eq $Title -and $process.Responding -and (Test-Path -LiteralPath $database)) {
                # Allow asynchronous appearance loading to finish before checking persistence.
                Start-Sleep -Seconds 3
                Write-Host "$Title installed startup passed."
                return
            }
        } while ([DateTime]::UtcNow -lt $deadline)
        throw "$Title did not open a responsive branded window and database."
    } finally {
        $process.Refresh()
        if (!$process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
    }
}

Install-Checked $PreviousInstaller ("/S /D=" + $installDir)
$oldBinary = Join-Path $installDir 'kitty.exe'
Check-Startup $oldBinary 'Kitty'
python (Join-Path $PSScriptRoot 'rebrand-store-smoke.py') seed $database
if ($LASTEXITCODE -ne 0) { throw 'Could not seed synthetic prior app data.' }
Copy-Item -LiteralPath (Join-Path $workspace 'src-tauri/icons/32x32.png') -Destination (Join-Path $dataDir 'background.png')
$wallpaperHash = (Get-FileHash -LiteralPath (Join-Path $dataDir 'background.png')).Hash
$shell = New-Object -ComObject WScript.Shell
$startMenu = [Environment]::GetFolderPath('Programs')
$desktop = [Environment]::GetFolderPath('Desktop')
# Ensure both migrations are exercised regardless of silent-install defaults.
foreach ($directory in @($startMenu, $desktop)) {
    $shortcut = $shell.CreateShortcut((Join-Path $directory 'Kitty.lnk'))
    $shortcut.TargetPath = $oldBinary
    $shortcut.Save()
}
Install-Checked $NewInstaller ("/S /UPDATE /D=" + $installDir)
$newBinary = Join-Path $installDir 'pantheon.exe'
if (!(Test-Path -LiteralPath $newBinary) -or (Test-Path -LiteralPath $oldBinary)) { throw 'Executable rename failed.' }
$registration = Get-ItemProperty -LiteralPath $registry
if ($registration.DisplayName -ne 'Pantheon' -or $registration.MainBinaryName -ne 'pantheon.exe') { throw 'Installer registration did not migrate.' }
foreach ($directory in @($startMenu, $desktop)) {
    if (Test-Path -LiteralPath (Join-Path $directory 'Kitty.lnk')) { throw 'Legacy shortcut remains.' }
    $shortcutPath = Join-Path $directory 'Pantheon.lnk'
    if (!(Test-Path -LiteralPath $shortcutPath)) { throw 'Branded shortcut is missing.' }
    if ($shell.CreateShortcut($shortcutPath).TargetPath -ne $newBinary) { throw 'Branded shortcut points to the wrong executable.' }
}
foreach ($component in @('msvcp140.dll','msvcp140_1.dll','vcruntime140.dll','vcruntime140_1.dll','VC-Runtime-NOTICE.txt')) {
    if (!(Test-Path -LiteralPath (Join-Path $installDir $component))) { throw "Missing installed runtime resource $component." }
}
if (!(Test-Path -LiteralPath (Join-Path $installDir 'dictation'))) { throw 'Bundled dictation resources are missing.' }
Check-Startup $newBinary 'Pantheon'
python (Join-Path $PSScriptRoot 'rebrand-store-smoke.py') verify $database
if ($LASTEXITCODE -ne 0) { throw 'Saved projects, conversation or appearance changed during upgrade.' }
if ((Get-FileHash -LiteralPath (Join-Path $dataDir 'background.png')).Hash -ne $wallpaperHash) { throw 'Saved wallpaper changed during upgrade.' }
Write-Host 'Installed old-to-new upgrade, shortcuts, runtime resources, branded startup, history and appearance passed.'
