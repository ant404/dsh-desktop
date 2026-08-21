# rollback-runtime.ps1
# Swap the ACTIVE dsh runtime with the preserved "dsh-runtime.previous" slot.
#
# The patched dsh-desktop update flow keeps the last-known-good runtime as
#   <dataDir>\runtime\dsh-runtime.previous
# before installing a new version. If the new version fails to start, run this
# script to roll back to the previous (working) version.
#
# IMPORTANT: run this while DSH Desktop is FULLY closed, then start it again.
#   Ensure no node process still holds port 3080 (see netstat -ano | findstr :3080).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File rollback-runtime.ps1
#   powershell -ExecutionPolicy Bypass -File rollback-runtime.ps1 -Force   (no prompt)

param([switch]$Force)
$ErrorActionPreference = 'Stop'

$rt = 'D:\DSH Desktop\data\runtime'
$a  = Join-Path $rt 'dsh-runtime'
$b  = Join-Path $rt 'dsh-runtime.previous'
$tmp = Join-Path $rt 'dsh-runtime.tmp-swap'

function Ver([string]$d) {
  try { $v = Get-Content (Join-Path $d 'package.json') -Raw | ConvertFrom-Json; return $v.version } catch { return 'unknown' }
}

if (-not (Test-Path $b)) {
  Write-Error "No '$b' found — nothing to roll back to.`n(The previous slot is created automatically after an update.)"
  exit 1
}
if (-not (Test-Path $a)) {
  Write-Error "No active '$a' found — nothing to roll back."
  exit 1
}

Write-Host "Current : $a  -> $((Ver $a))"
Write-Host "Previous: $b  -> $((Ver $b))"
if (-not $Force) {
  $ans = Read-Host "Swap so the previous version becomes active? [y/N]"
  if ($ans -notmatch '^[yY]') { Write-Host 'Aborted.'; exit 0 }
}

if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Rename-Item $a $tmp
Rename-Item $b $a
Rename-Item $tmp $b

Write-Host ""
Write-Host "Rolled back. Active runtime is now $((Ver $a))."
Write-Host "1) Fully close DSH Desktop (end any node holding port 3080)."
Write-Host "2) Start DSH Desktop again."
