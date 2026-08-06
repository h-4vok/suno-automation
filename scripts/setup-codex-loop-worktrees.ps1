[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [string]$ControlRoot,

  [Parameter(Mandatory = $true)]
  [string]$Worker1Path,

  [Parameter(Mandatory = $true)]
  [string]$Worker2Path,

  [string]$BaseBranch = "main",

  [switch]$Apply
)

$ErrorActionPreference = "Stop"

if (
  $BaseBranch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$' -or
  $BaseBranch.Contains('..') -or
  $BaseBranch.Contains('@{') -or
  $BaseBranch.Contains('//') -or
  $BaseBranch.EndsWith('/') -or
  $BaseBranch.EndsWith('.') -or
  $BaseBranch.EndsWith('.lock') -or
  $BaseBranch -match '(^|/)\.'
) {
  throw "Base branch is invalid."
}

function Resolve-ExistingDirectory([string]$Path) {
  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $resolved.Path -PathType Container)) {
    throw "Expected an existing directory."
  }
  return $resolved.Path
}

function Resolve-FutureDirectory([string]$Path) {
  $parent = Split-Path -Parent $Path
  $leaf = Split-Path -Leaf $Path
  if ([string]::IsNullOrWhiteSpace($parent) -or [string]::IsNullOrWhiteSpace($leaf)) {
    throw "Worker path must have an existing parent and a final directory name."
  }
  $resolvedParent = Resolve-ExistingDirectory $parent
  return [System.IO.Path]::GetFullPath((Join-Path $resolvedParent $leaf))
}

$control = Resolve-ExistingDirectory $ControlRoot
$worker1 = Resolve-FutureDirectory $Worker1Path
$worker2 = Resolve-FutureDirectory $Worker2Path

if ($worker1 -eq $worker2 -or $worker1 -eq $control -or $worker2 -eq $control) {
  throw "Control and worker paths must be three distinct directories."
}

foreach ($worker in @($worker1, $worker2)) {
  if (Test-Path -LiteralPath $worker) {
    throw "A requested worker path already exists; no changes were made."
  }
}

$insideWorktree = git -C $control rev-parse --is-inside-work-tree
if ($LASTEXITCODE -ne 0 -or $insideWorktree -ne "true") {
  throw "Control root is not a Git worktree."
}
# `ls-remote` observes the remote without changing shared worktree metadata. This is essential
# for the inspection-only default: fetch is allowed only after -Apply.
$baseCommit = git -C $control ls-remote --exit-code origin "refs/heads/$BaseBranch" | ForEach-Object { ($_ -split "\s+")[0] }
if ($LASTEXITCODE -ne 0 -or $baseCommit -notmatch '^[a-fA-F0-9]{7,64}$') {
  throw "Remote base branch could not be resolved."
}

if (-not $Apply) {
  Write-Output "Dry-run: two detached worktrees would be created from the verified remote base."
  Write-Output "Re-run with -Apply only after inspecting all three resolved paths."
  return
}

foreach ($worker in @($worker1, $worker2)) {
  if ($PSCmdlet.ShouldProcess($worker, "Create detached Codex worker worktree")) {
    git -C $control fetch --prune origin $BaseBranch
    if ($LASTEXITCODE -ne 0) {
      throw "Remote base fetch failed."
    }
    git -C $control worktree add --detach $worker "origin/$BaseBranch"
    if ($LASTEXITCODE -ne 0) {
      throw "Git worktree creation failed. Existing evidence was preserved."
    }
    corepack pnpm --dir $worker install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
      throw "Dependency setup failed. The created worktree was preserved for inspection."
    }
  }
}

Write-Output "Two detached worker worktrees were created. Add each as a permanent Codex project manually."
