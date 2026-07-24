[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][int]$Issue,
  [Parameter(Mandatory = $true)][string]$Branch,
  [int]$RecoveryCount = 0
)

$ErrorActionPreference = "Stop"

function Read-Json([string]$Path) {
  return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable
}

function Write-JsonAtomic([string]$Path, [hashtable]$Value) {
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8 -NoNewline
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

$config = Read-Json $ConfigPath
$commonDir = (git -C $config.worker.worktreePath rev-parse --git-common-dir 2>$null)
if ($LASTEXITCODE -ne 0) { throw "Unable to resolve shared Git directory." }
$commonDirectoryPath = if ([IO.Path]::IsPathRooted($commonDir)) { $commonDir } else { Join-Path $config.worker.worktreePath $commonDir }
$stateDirectory = Join-Path ([IO.Path]::GetFullPath($commonDirectoryPath)) "codex-loop\scheduler"
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$journalPath = Join-Path $stateDirectory "$($config.worker.id).json"
$logPath = Join-Path $stateDirectory "$($config.worker.id)-$Issue.log"

$isRecovery = $RecoveryCount -gt 0
$mode = if ($isRecovery) { "recovery" } else { "implementation" }
$prompt = @"
You are the sole local Codex CLI worker for GitHub issue #$Issue in this exact worktree. This issue is already claimed. Work only on this issue and branch $Branch. Read AGENTS.md and the GitHub contract with gh before editing. $mode run: preserve all existing useful changes and commits; never reset, clean, force-push, merge, approve, or access Suno. Create or resume the recorded branch, implement, test deeply, commit, push the recorded branch, open or reuse exactly one draft PR, then move the issue to codex-review and park the clean worktree detached on its remote base. If verification cannot safely succeed, leave the worktree intact and move the issue to codex-needs-attention with a concise safe reason. Do not select or claim another issue.
"@

$journal = @{
  version = 1; slot = $config.worker.id; status = "running"; issue = $Issue; branch = $Branch
  wrapperPid = $PID; wrapperStartedAt = [DateTime]::UtcNow.ToString("o")
  lastWrapperHeartbeatAt = [DateTime]::UtcNow.ToString("o"); lastCodexEventAt = $null
  recoveryCount = $RecoveryCount; logFile = $logPath; phase = "starting"
}
Write-JsonAtomic $journalPath $journal
$child = $null
try {
  $arguments = @("exec", "--json", $prompt)
  $child = Start-Process -FilePath "codex" -ArgumentList $arguments -WorkingDirectory $config.worker.worktreePath -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.stderr" -PassThru
  $journal.codexPid = $child.Id
  $journal.phase = "working"
  Write-JsonAtomic $journalPath $journal
  while (-not $child.HasExited) {
    Start-Sleep -Seconds ([Math]::Max(5, [int]$config.scheduler.heartbeatSeconds))
    $journal.lastWrapperHeartbeatAt = [DateTime]::UtcNow.ToString("o")
    $journal.lastCodexEventAt = if (Test-Path -LiteralPath $logPath) { (Get-Item -LiteralPath $logPath).LastWriteTimeUtc.ToString("o") } else { $null }
    $journal.phase = "working"
    Write-JsonAtomic $journalPath $journal
  }
  $journal.status = if ($child.ExitCode -eq 0) { "completed" } else { "failed" }
  $journal.exitCode = $child.ExitCode
  $journal.phase = "terminal"
} catch {
  $journal.status = "failed"
  $journal.phase = "terminal"
  $journal.errorCode = "wrapper-error"
} finally {
  $journal.lastWrapperHeartbeatAt = [DateTime]::UtcNow.ToString("o")
  $journal.completedAt = [DateTime]::UtcNow.ToString("o")
  Write-JsonAtomic $journalPath $journal
}
