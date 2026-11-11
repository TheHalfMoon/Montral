# Montral Windows 11 / Docker Desktop safety preflight.
# Read-only: never starts Docker, pulls images, changes WSL, alters volumes, or uses credentials.
# Exit 0 = basic prerequisites pass, 2 = blocked, 1 = script error.
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z]$')][string]$SystemDrive = 'C',
    [ValidatePattern('^[A-Za-z]$')][string]$WorkspaceDrive = 'D',
    [ValidateRange(0, 10000)][int]$MinimumSystemFreeGB = 12,
    [ValidateRange(0, 10000)][int]$MinimumWorkspaceFreeGB = 15,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-FreeGB([string]$Letter) {
    $drive = Get-PSDrive -Name $Letter.ToUpperInvariant() -PSProvider FileSystem -ErrorAction SilentlyContinue
    if ($null -eq $drive -or $null -eq $drive.Free) { return $null }
    return [math]::Round(([double]$drive.Free / 1GB), 2)
}

function Check-DockerDaemon {
    if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
        return @{ ok = $false; detail = 'Docker CLI not found' }
    }
    # Never start Docker here; unavailable daemon is a blocker.
    try {
        $info = & docker info --format '{{.ServerVersion}}' 2>&1
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$info)) {
            return @{ ok = $true; detail = 'Docker engine responds' }
        }
        return @{ ok = $false; detail = 'Docker engine not running or inaccessible' }
    } catch {
        return @{ ok = $false; detail = 'Docker engine not running or inaccessible' }
    }
}

try {
    if ($null -eq (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
        $wsl = 'WSL executable not found'
        $wslReady = $false
    } else {
        # Enumerate registered distributions only; no WSL machine is started.
        try {
            $wslListing = & wsl.exe --list --quiet 2>&1
            $wslReady = ($LASTEXITCODE -eq 0)
            $wsl = if ($wslReady) { 'WSL distribution enumeration succeeded' } else { 'WSL distribution enumeration failed' }
        } catch {
            $wslReady = $false
            $wsl = 'WSL distribution enumeration failed'
        }
    }

    $systemFree = Read-FreeGB $SystemDrive
    $workspaceFree = Read-FreeGB $WorkspaceDrive
    $checks = @()
    $systemOk = ($null -ne $systemFree -and $systemFree -ge $MinimumSystemFreeGB)
    $workspaceOk = ($null -ne $workspaceFree -and $workspaceFree -ge $MinimumWorkspaceFreeGB)
    $checks += [pscustomobject]@{
        name = 'system_disk'
        ok = [bool]$systemOk
        detail = if ($null -ne $systemFree) { "$($SystemDrive.ToUpperInvariant()): $systemFree GB free (minimum $MinimumSystemFreeGB GB)" } else { 'System drive unavailable' }
    }
    $checks += [pscustomobject]@{
        name = 'workspace_disk'
        ok = [bool]$workspaceOk
        detail = if ($null -ne $workspaceFree) { "$($WorkspaceDrive.ToUpperInvariant()): $workspaceFree GB free (minimum $MinimumWorkspaceFreeGB GB)" } else { 'Workspace drive unavailable' }
    }
    $checks += [pscustomobject]@{ name = 'wsl_enumeration'; ok = [bool]$wslReady; detail = $wsl }
    $docker = Check-DockerDaemon
    $checks += [pscustomobject]@{ name = 'docker_daemon'; ok = [bool]$docker.ok; detail = [string]$docker.detail }

    $blocked = @($checks | Where-Object { -not $_.ok })
    $status = if ($blocked.Count -eq 0) { 'PASS' } else { 'BLOCKED' }
    if ($Json) {
        [pscustomobject]@{ status = $status; read_only = $true; checks = $checks } | ConvertTo-Json -Depth 5
    } else {
        Write-Output "MONTRAL_WINDOWS_DOCKER_PREFLIGHT_$status"
        foreach ($check in $checks) {
            $state = if ($check.ok) { 'PASS' } else { 'BLOCKED' }
            Write-Output "$state $($check.name): $($check.detail)"
        }
        Write-Output 'No containers or Windows services were started, modified or removed.'
    }
    if ($blocked.Count -gt 0) { exit 2 }
    exit 0
} catch {
    Write-Error 'Montral Windows Docker preflight encountered an unexpected error. No Docker state was changed.'
    exit 1
}
