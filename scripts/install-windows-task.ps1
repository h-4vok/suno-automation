param(
  [string]$TaskName = "SunoAutomationCoordinator"
)

$ErrorActionPreference = "Stop"
$WorkspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$PnpmPath = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$Action = New-ScheduledTaskAction -Execute $PnpmPath -Argument "start" -WorkingDirectory $WorkspacePath
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Days 1) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Run local Suno automation coordinator after logon" -Force
Write-Output "Registered task '$TaskName' for workspace '$WorkspacePath'."
