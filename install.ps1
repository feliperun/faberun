#Requires -Version 5.1
<#
    Install faberun on Windows into the layout src/host/home.mjs and
    src/cli/update.mjs own:

      $FABERUN_HOME\versions\<version>\      the extracted release
      $FABERUN_HOME\current -> versions\<v>  the live version (a junction)
      $FABERUN_BIN_DIR\faberun.cmd           shim for cmd and PowerShell
      $FABERUN_BIN_DIR\faberun               shim for Git Bash and MSYS

    The Windows half of install.sh: same environment variables, same output
    tokens, same idempotence. Three things differ, each because Windows differs.

    `current` is a junction, not a symlink: a directory symlink needs Developer
    Mode or an elevated shell, a junction needs neither, and both resolve
    through `realpathSync`, which is how the CLI identifies its own version.

    The binary is two shims rather than one link: Windows cannot execute a
    `.mjs` file through a link, PowerShell and cmd find `faberun.cmd` through
    PATHEXT, and Git Bash finds only the extensionless POSIX script.

    `tar` is the one in System32 when it is there (bsdtar, shipped since
    Windows 10 1803). A GNU tar earlier on PATH -- Git for Windows installs one
    -- reads `C:\...` as a remote host and fails with "Cannot connect to C:".
#>
[CmdletBinding()]
param(
    # Install root; default ~\.faberun.
    [string] $FaberunHome = $env:FABERUN_HOME,
    # Where the shims go; default $FaberunHome\bin.
    [string] $BinDir = $env:FABERUN_BIN_DIR,
    # Install this tag instead of the newest release.
    [string] $Version = $env:FABERUN_VERSION,
    # A local tarball or directory instead of the network.
    [string] $InstallSource = $env:FABERUN_INSTALL_SOURCE,
    # Skip the final `faberun setup`.
    [switch] $NoSetup,
    # Add $BinDir to the user PATH instead of only advising it.
    [switch] $AddToPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'feliperun/faberun'
$ReleasesUrl = "https://api.github.com/repos/$Repo/releases/latest"
$ArchiveBase = "https://github.com/$Repo/archive/refs"

# U+00B7, written as a code point so this file stays ASCII: PowerShell 5.1
# reads a BOM-less script as ANSI and would mangle the character itself.
$Dot = [char]0xB7

if (-not $NoSetup -and $env:FABERUN_NO_SETUP) { $NoSetup = $true }
if (-not $AddToPath -and $env:FABERUN_ADD_TO_PATH) { $AddToPath = $true }
if (-not $FaberunHome) { $FaberunHome = Join-Path $env:USERPROFILE '.faberun' }
# `~\.local\bin` is a POSIX habit that is on no Windows PATH. The install root
# owns its own bin directory instead, so one entry on PATH covers the tool.
if (-not $BinDir) { $BinDir = Join-Path $FaberunHome 'bin' }

function Write-Status {
    param([string] $Level, [string] $Name, [string] $Detail)
    $line = "[$Level] $Name $Dot $Detail"
    if ($Level -eq 'fail') { [Console]::Error.WriteLine($line) } else { Write-Host $line }
}

function Stop-Install {
    param([string] $Name, [string] $Detail)
    Write-Status 'fail' $Name $Detail
    exit 1
}

# Remove a path that may be a junction without following it. `Remove-Item
# -Recurse` over a reparse point deleted the *target* on Windows PowerShell
# builds still in the field, and here the target is the installed version the
# link exists to serve.
function Remove-LinkOrDirectory {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($Path) }
    else { Remove-Item -LiteralPath $Path -Recurse -Force }
}

# ---------------------------------------------------------------------------
# 1. Requirements
# ---------------------------------------------------------------------------

$node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $node) { Stop-Install 'node' 'node 22 or newer is required; install it from https://nodejs.org/' }
$nodeVersion = & $node.Source -p 'process.versions.node' 2>$null
if ($LASTEXITCODE -ne 0 -or -not $nodeVersion) { Stop-Install 'node' "could not read the node version from $($node.Source); install node 22 or newer from https://nodejs.org/" }
$nodeMajor = 0
if (-not [int]::TryParse(($nodeVersion -split '\.')[0], [ref] $nodeMajor)) { Stop-Install 'node' "could not read the node version from $($node.Source); install node 22 or newer from https://nodejs.org/" }
if ($nodeMajor -lt 22) { Stop-Install 'node' "node 22 or newer is required, found $nodeVersion; install it from https://nodejs.org/" }
Write-Status 'ok' 'node' $nodeVersion

$systemTar = Join-Path ([Environment]::GetFolderPath('System')) 'tar.exe'
if (Test-Path -LiteralPath $systemTar -PathType Leaf) {
    $tar = $systemTar
} else {
    $found = (Get-Command tar -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $found) { Stop-Install 'tar' 'tar is required to unpack the release; Windows 10 1803 and newer ship it in System32' }
    $tar = $found.Source
}
Write-Status 'ok' 'tar' $tar

# ---------------------------------------------------------------------------
# 2. Resolve the version
# ---------------------------------------------------------------------------

if (-not $Version) {
    # TLS 1.2 is not the default under Windows PowerShell 5.1 and the GitHub API
    # refuses anything older.
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {
        # A newer runtime negotiates TLS on its own and rejects the assignment; nothing to fix.
    }
    $tag = $null
    try {
        $release = Invoke-RestMethod -Uri $ReleasesUrl -Headers @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'faberun-install' } -UseBasicParsing
        if ($release.PSObject.Properties['tag_name']) { $tag = [string] $release.tag_name }
    } catch {
        # No release feed (offline, rate-limited, or no release yet) is the
        # `main` case below, not a failed install.
    }
    if ($tag) {
        $Version = $tag
    } else {
        Write-Status 'warn' 'release' 'no release yet, installing main'
        $Version = 'main'
    }
}

# The directory is the bare version, matching src/cli/update.mjs; a release tag
# carries the leading `v`, a plain number does not.
$versionKey = if ($Version.StartsWith('v')) { $Version.Substring(1) } else { $Version }

# ---------------------------------------------------------------------------
# 3. Fetch and extract
# ---------------------------------------------------------------------------

$versionsDir = Join-Path $FaberunHome 'versions'
$target = Join-Path $versionsDir $versionKey
$partial = Join-Path $versionsDir "$versionKey.partial"
$tarball = Join-Path (Join-Path $FaberunHome 'tmp') 'install.tar.gz'

New-Item -ItemType Directory -Path $versionsDir -Force | Out-Null
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
Remove-LinkOrDirectory $partial
New-Item -ItemType Directory -Path $partial -Force | Out-Null

function Expand-Release {
    param([string] $Archive, [string] $Destination)
    & $tar -xzf $Archive --strip-components=1 -C $Destination
    if ($LASTEXITCODE -ne 0) { throw "tar exited $LASTEXITCODE" }
}

try {
    if ($InstallSource) {
        if (Test-Path -LiteralPath $InstallSource -PathType Container) {
            Copy-Item -Path (Join-Path $InstallSource '*') -Destination $partial -Recurse -Force
        } elseif (Test-Path -LiteralPath $InstallSource -PathType Leaf) {
            Expand-Release -Archive $InstallSource -Destination $partial
        } else {
            throw "$InstallSource does not exist"
        }
    } else {
        $archiveUrl = switch -Regex ($Version) {
            '^main$' { "$ArchiveBase/heads/main.tar.gz"; break }
            '^v' { "$ArchiveBase/tags/$Version.tar.gz"; break }
            default { "$ArchiveBase/tags/v$Version.tar.gz" }
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $tarball) -Force | Out-Null
        try {
            Invoke-WebRequest -Uri $archiveUrl -OutFile $tarball -UseBasicParsing
        } catch {
            throw "download $archiveUrl"
        }
        Expand-Release -Archive $tarball -Destination $partial
        Remove-Item -LiteralPath $tarball -Force
    }
} catch {
    Remove-LinkOrDirectory $partial
    Stop-Install 'source' $_.Exception.Message
}

if (-not (Test-Path -LiteralPath (Join-Path $partial 'bin\faberun.mjs') -PathType Leaf)) {
    Remove-LinkOrDirectory $partial
    Stop-Install 'source' 'the extracted tree has no bin\faberun.mjs'
}

# ---------------------------------------------------------------------------
# 4. Install the version, repoint current, write the shims
# ---------------------------------------------------------------------------

Remove-LinkOrDirectory $target
Move-Item -LiteralPath $partial -Destination $target

# Removing the old link and making a new one, rather than the rename install.sh
# uses: renaming a directory over an existing junction fails with EPERM on
# Windows, and the two calls leave `current` absent for the moment between them.
$current = Join-Path $FaberunHome 'current'
Remove-LinkOrDirectory $current
New-Item -ItemType Junction -Path $current -Target $target | Out-Null

$entry = Join-Path $current 'bin\faberun.mjs'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$cmdShim = Join-Path $BinDir 'faberun.cmd'
[System.IO.File]::WriteAllText($cmdShim, "@echo off`r`nrem Written by faberun's install.ps1; it points through $current.`r`nnode `"$entry`" %*`r`n", $utf8NoBom)
# Git Bash resolves neither PATHEXT nor a `.cmd`, so the extensionless POSIX
# script is what `faberun` means in the shell most of this tool's users type in.
$shShim = Join-Path $BinDir 'faberun'
$shEntry = $entry.Replace('\', '/')
[System.IO.File]::WriteAllText($shShim, "#!/bin/sh`n# Written by faberun's install.ps1; it points through $current.`nexec node `"$shEntry`" `"`$@`"`n", $utf8NoBom)

# ---------------------------------------------------------------------------
# 5. Verify the installed shim runs and reports its own version
# ---------------------------------------------------------------------------

$versionOutput = & $cmdShim --version 2>$null
$verifyExit = $LASTEXITCODE
$printedLine = [string] (@($versionOutput) | Select-Object -First 1)
if ($verifyExit -ne 0 -or -not $printedLine) { Stop-Install 'verify' "$cmdShim --version failed" }
$printed = if ($printedLine.StartsWith('faberun ')) { $printedLine.Substring('faberun '.Length) } else { $printedLine }
Write-Status 'ok' 'installed' "faberun $printed $Dot $cmdShim"

# ---------------------------------------------------------------------------
# 6. PATH
# ---------------------------------------------------------------------------

function Test-OnPath {
    param([string] $Value, [string] $Directory)
    $wanted = $Directory.TrimEnd('\')
    return @($Value -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') }) -contains $wanted
}

if (-not (Test-OnPath $env:PATH $BinDir)) {
    if ($AddToPath) {
        $userPath = [string] [Environment]::GetEnvironmentVariable('Path', 'User')
        if (-not (Test-OnPath $userPath $BinDir)) {
            $entries = @($userPath -split ';' | Where-Object { $_ }) + $BinDir
            [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
        }
        $env:PATH = "$BinDir;$env:PATH"
        Write-Status 'ok' 'path' "$BinDir added to the user PATH; open a new terminal for it to take effect"
    } else {
        Write-Status 'warn' 'path' "add $BinDir to PATH"
        Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$BinDir', 'User')"
    }
}

# ---------------------------------------------------------------------------
# 7. Hand off to setup
# ---------------------------------------------------------------------------

if (-not $NoSetup) {
    if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
        & $cmdShim setup
        exit $LASTEXITCODE
    }
    Write-Host "next $Dot faberun setup"
}
