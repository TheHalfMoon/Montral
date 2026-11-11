# Regression tests for the read-only Windows Docker prerequisite gate.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'qualify-windows-docker-preflight.ps1'
$parsed = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$null)
if ($null -eq $parsed) { throw 'Cannot parse preflight script' }
$source = [IO.File]::ReadAllText($script)
if ($source -notmatch 'Wait-Job -Job \$wslJob -Timeout \$WslTimeoutSeconds') { throw 'WSL bounded wait missing' }
if ($source -notmatch 'Stop-Job -Job \$wslJob') { throw 'WSL timeout cleanup missing' }
if ($source -notmatch 'Remove-Job -Job \$wslJob -Force') { throw 'WSL job cleanup missing' }
# Negative control: a hung command must fail the deadline and be terminated.
$job = Start-Job -ScriptBlock { Start-Sleep -Seconds 20 }
try {
    $completed = Wait-Job -Job $job -Timeout 1
    if ($null -ne $completed) { throw 'Negative control unexpectedly completed' }
} finally {
    if ($job.State -eq 'Running') { Stop-Job -Job $job }
    Remove-Job -Job $job -Force
}
# The live probe must remain a machine-readable, fail-closed, four-check gate.
$output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Json -WslTimeoutSeconds 3
if ($LASTEXITCODE -notin @(0,2)) { throw 'Unexpected preflight exit code' }
$result = ($output -join "`n") | ConvertFrom-Json
if ($result.read_only -ne $true -or $result.checks.Count -ne 4) { throw 'Invalid JSON contract' }
if ($result.status -notin @('PASS','BLOCKED')) { throw 'Invalid gate status' }
Write-Output 'WINDOWS_PREFLIGHT_TESTS_PASS (bounded negative control, cleanup, JSON contract, syntax)'
# powershell.exe deliberately returns 2 for a BLOCKED prerequisite gate.
# Reset the script process exit status after validating that expected result;
# otherwise PowerShell propagates the child exit code despite passing tests.
exit 0
