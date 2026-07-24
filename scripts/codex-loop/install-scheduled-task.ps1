[CmdletBinding(SupportsShouldProcess)]
param([Parameter(Mandatory = $true)][string]$ConfigPath)

$ErrorActionPreference = "Stop"
# The default Windows JSON parser returns a PSCustomObject.
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
if ($config.version -ne 1 -or -not $config.scheduler.taskName -or [int]$config.scheduler.pollMinutes -lt 1) { throw "Scheduler config is invalid." }
$dispatcher = Join-Path $PSScriptRoot "dispatch.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$dispatcher`" -ConfigPath `"$ConfigPath`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ([int]$config.scheduler.pollMinutes)) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 8) -MultipleInstances IgnoreNew
if ($PSCmdlet.ShouldProcess($config.scheduler.taskName, "Install one-worker Codex loop scheduled task")) {
  Register-ScheduledTask -TaskName $config.scheduler.taskName -Action $action -Trigger $trigger -Settings $settings -Description "Local deterministic GitHub claim and Codex CLI worker. Stops itself after configured tick limit." -Force | Out-Null
}
