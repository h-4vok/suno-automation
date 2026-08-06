[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath
)

$ErrorActionPreference = "Stop"

function Read-Json([string]$Path) {
  # Keep the executor compatible with the Windows PowerShell 5.1 installed by default.
  Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}
function Write-JsonAtomic([string]$Path, [object]$Value) {
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try { $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8 -NoNewline; Move-Item -LiteralPath $temporary -Destination $Path -Force }
  finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
function Set-JsonField([object]$Value, [string]$Name, [object]$FieldValue) {
  # ConvertFrom-Json returns PSCustomObject on Windows PowerShell 5.1.  A
  # recovered journal can legitimately predate a newly-added field, and
  # assigning that field directly then throws instead of recording recovery.
  if ($Value -is [System.Collections.IDictionary]) {
    $Value[$Name] = $FieldValue
    return
  }
  $Value | Add-Member -NotePropertyName $Name -NotePropertyValue $FieldValue -Force
}
function Test-ProcessIdentity($Pid, [string]$StartedAt) {
  try {
    $process = Get-Process -Id $Pid -ErrorAction Stop
    return $process.StartTime.ToUniversalTime() -le ([DateTime]::Parse($StartedAt).ToUniversalTime().AddSeconds(2))
  } catch { return $false }
}
function Set-IssueAttention([int]$Issue, [string]$Reason) {
  gh issue edit $Issue --repo $config.repository --remove-label codex-in-progress --add-label codex-needs-attention | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to mark issue attention." }
  gh issue comment $Issue --repo $config.repository --body "codex-scheduler event=attention reason=$Reason" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to record attention." }
}
function Start-Worker([int]$Issue, [string]$Branch, [int]$RecoveryCount) {
  $wrapper = Join-Path $PSScriptRoot "worker-wrapper.ps1"
  $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $wrapper, "-ConfigPath", $ConfigPath, "-Issue", "$Issue", "-Branch", $Branch, "-RecoveryCount", "$RecoveryCount")
  if ($WhatIf) { Write-Output "Would launch worker for issue #$Issue."; return }
  Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WorkingDirectory $config.worker.worktreePath -WindowStyle Hidden | Out-Null
}
function Start-Recovery([object]$Journal, [string]$Reason) {
  if ([int]$Journal.recoveryCount -ge [int]$config.scheduler.maxRecoveryAttempts) {
    if (-not $WhatIf) { Set-IssueAttention $Journal.issue "recovery-exhausted" }
    Set-JsonField $Journal "status" "attention"; Set-JsonField $Journal "completedAt" ([DateTime]::UtcNow.ToString("o")); Set-JsonField $Journal "recoveryReason" $Reason; Write-JsonAtomic $journalPath $Journal
    Write-Output "Recovery limit exhausted; issue requires attention."; return
  }
  Set-JsonField $Journal "status" "launching"
  Set-JsonField $Journal "recoveryCount" ([int]$Journal.recoveryCount + 1)
  $recoveryStartedAt = [DateTime]::UtcNow.ToString("o")
  Set-JsonField $Journal "startedAt" $recoveryStartedAt
  Set-JsonField $Journal "lastRecoveryAt" $recoveryStartedAt
  Set-JsonField $Journal "recoveryReason" $Reason
  Write-JsonAtomic $journalPath $Journal
  Start-Worker $Journal.issue $Journal.branch $Journal.recoveryCount
}
function Test-WorkerParked {
  $status = git -C $config.worker.worktreePath status --porcelain
  if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace(($status -join ""))) { return $false }
  $head = git -C $config.worker.worktreePath symbolic-ref -q --short HEAD
  return $LASTEXITCODE -ne 0
}

$config = Read-Json $ConfigPath
if ($config.version -ne 1 -or -not $config.repository -or -not $config.worker.worktreePath -or -not $config.worker.id) { throw "Scheduler config is invalid." }
if ([int]$config.scheduler.maxTicks -lt 1 -or [int]$config.scheduler.maxRecoveryAttempts -lt 0 -or [int]$config.scheduler.heartbeatSeconds -lt 5 -or [int]$config.scheduler.stalledAfterSeconds -lt [int]$config.scheduler.heartbeatSeconds) { throw "Scheduler timing limits are invalid." }
if (-not (Test-Path -LiteralPath $config.worker.worktreePath -PathType Container)) { throw "Configured worker worktree is unavailable." }
$commonDir = git -C $config.worker.worktreePath rev-parse --git-common-dir
if ($LASTEXITCODE -ne 0) { throw "Unable to resolve shared Git directory." }
$commonDirectoryPath = if ([IO.Path]::IsPathRooted($commonDir)) { $commonDir } else { Join-Path $config.worker.worktreePath $commonDir }
$stateDirectory = Join-Path ([IO.Path]::GetFullPath($commonDirectoryPath)) "codex-loop\scheduler"
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$schedulerPath = Join-Path $stateDirectory "scheduler.json"
$journalPath = Join-Path $stateDirectory "$($config.worker.id).json"
$scheduler = if (Test-Path -LiteralPath $schedulerPath) { Read-Json $schedulerPath } else { @{ version = 1; ticks = 0 } }
if ([int]$scheduler.ticks -ge [int]$config.scheduler.maxTicks) { Write-Output "Tick limit reached; scheduler remains disabled."; return }
Set-JsonField $scheduler "ticks" ([int]$scheduler.ticks + 1)
Set-JsonField $scheduler "lastTickAt" ([DateTime]::UtcNow.ToString("o"))
Write-JsonAtomic $schedulerPath $scheduler
$disableAfterThisTick = [int]$scheduler.ticks -ge [int]$config.scheduler.maxTicks
if ($disableAfterThisTick -and -not $WhatIf) {
  Disable-ScheduledTask -TaskName $config.scheduler.taskName | Out-Null
  Set-JsonField $scheduler "disabledAt" ([DateTime]::UtcNow.ToString("o"))
  Write-JsonAtomic $schedulerPath $scheduler
}

$journal = if (Test-Path -LiteralPath $journalPath) { Read-Json $journalPath } else { $null }
if ($null -ne $journal -and $journal.status -eq "launching") {
  $launchAge = [DateTime]::UtcNow - [DateTime]::Parse($journal.startedAt)
  if ($launchAge.TotalSeconds -le 60) { Write-Output "Worker wrapper is launching."; return }
  if ([int]$journal.recoveryCount -ge [int]$config.scheduler.maxRecoveryAttempts) {
    if (-not $WhatIf) { Set-IssueAttention $journal.issue "wrapper-launch-exhausted" }
    Set-JsonField $journal "status" "attention"; Set-JsonField $journal "completedAt" ([DateTime]::UtcNow.ToString("o")); Write-JsonAtomic $journalPath $journal
    Write-Output "Wrapper launch limit exhausted; issue requires attention."; return
  }
  Start-Recovery $journal "wrapper-launch-timeout"
  return
}
if ($null -ne $journal -and $journal.status -eq "running") {
  $alive = Test-ProcessIdentity $journal.wrapperPid $journal.wrapperStartedAt
  $age = [DateTime]::UtcNow - [DateTime]::Parse($journal.lastWrapperHeartbeatAt)
  if ($alive -and $age.TotalSeconds -le [int]$config.scheduler.stalledAfterSeconds) { Write-Output "Worker slot busy."; return }
  $recoveryCount = [int]$journal.recoveryCount
  if ($alive) { taskkill.exe /PID $journal.wrapperPid /T /F | Out-Null }
  if ($recoveryCount -ge [int]$config.scheduler.maxRecoveryAttempts) {
    if (-not $WhatIf) { Set-IssueAttention $journal.issue "recovery-exhausted" }
    Set-JsonField $journal "status" "attention"; Set-JsonField $journal "completedAt" ([DateTime]::UtcNow.ToString("o")); Write-JsonAtomic $journalPath $journal
    Write-Output "Recovery limit exhausted; issue requires attention."; return
  }
  Start-Recovery $journal "worker-stalled"
  return
}
if ($null -ne $journal -and $journal.status -eq "failed") {
  # A pre-launch failure (for example a Windows command-shim resolution
  # failure) has no useful Codex process to preserve. Retry the same claimed
  # issue and branch under the bounded recovery policy.
  Start-Recovery $journal "worker-terminal-failed"
  return
}
if ($null -ne $journal -and $journal.status -in @("completed", "attention")) {
  if ($journal.status -eq "completed" -and (Test-WorkerParked)) {
    $issueState = gh issue view $journal.issue --repo $config.repository --json labels,state | ConvertFrom-Json
    if ($LASTEXITCODE -eq 0 -and $issueState.state -eq "OPEN" -and (@($issueState.labels | ForEach-Object name) -contains "codex-review")) {
      Set-JsonField $journal "status" "released"; Set-JsonField $journal "releasedAt" ([DateTime]::UtcNow.ToString("o")); Write-JsonAtomic $journalPath $journal
      $journal = $null
    }
  }
  if ($null -ne $journal) {
    # A terminal wrapper is not proof that the agent published correctly. Preserve its work and do not take another issue.
    Write-Output "Worker has terminal or recovery state; no automatic slot reuse."; return
  }
}

if ($WhatIf) { Write-Output "Worker slot free; would query GitHub."; return }
$candidates = @(gh issue list --repo $config.repository --state open --label codex-ready --limit 100 --json number,createdAt | ConvertFrom-Json) | Sort-Object createdAt, number
if ($LASTEXITCODE -ne 0) { throw "GitHub issue query failed." }
if ($candidates.Count -eq 0) { Write-Output "No codex-ready issue."; return }
$issue = [int]$candidates[0].number
$fresh = gh issue view $issue --repo $config.repository --json number,state,labels | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $fresh.state -ne "OPEN" -or -not (@($fresh.labels | ForEach-Object name) -contains "codex-ready")) { Write-Output "Candidate changed; no claim."; return }
gh issue edit $issue --repo $config.repository --remove-label codex-ready --add-label codex-in-progress | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Issue claim failed." }
$attempt = [guid]::NewGuid().ToString()
gh issue comment $issue --repo $config.repository --body "codex-scheduler event=claimed attempt=$attempt slot=$($config.worker.id)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Issue was claimed but claim audit failed; leaving work untouched." }
$branch = "codex/$issue-scheduler-worker"
$launchJournal = @{ version = 1; slot = $config.worker.id; status = "launching"; issue = $issue; branch = $branch; startedAt = [DateTime]::UtcNow.ToString("o"); recoveryCount = 0 }
Write-JsonAtomic $journalPath $launchJournal
Start-Worker $issue $branch 0
