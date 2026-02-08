Param(
  [string]$ArenaBaseUrl = "http://localhost:4000",
  [string]$AgentName = "",
  [int]$Offer10Enabled = 0,
  [int]$ExitAfterGame = 1
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($AgentName)) {
  $AgentName = "codx" + (Get-Random -Maximum 10000).ToString("0000")
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logsDir = Join-Path $repoRoot "logs"
New-Item -ItemType Directory -Force $logsDir | Out-Null

$credPath = Join-Path $logsDir ($AgentName + "-cred.json")

$env:ARENA_BASE_URL = $ArenaBaseUrl
$env:AGENT_NAME = $AgentName
$env:AGENT_CREDENTIAL_PATH = $credPath
$env:OFFER10_ENABLED = "$Offer10Enabled"
$env:EXIT_AFTER_GAME = "$ExitAfterGame"

Write-Output ("ARENA_BASE_URL=" + $env:ARENA_BASE_URL)
Write-Output ("AGENT_NAME=" + $env:AGENT_NAME)
Write-Output ("AGENT_CREDENTIAL_PATH=" + $env:AGENT_CREDENTIAL_PATH)
Write-Output ("OFFER10_ENABLED=" + $env:OFFER10_ENABLED)
Write-Output ("EXIT_AFTER_GAME=" + $env:EXIT_AFTER_GAME)
Write-Output ""
Write-Output "Starting daemon agent (Ctrl+C to stop)..."

Set-Location $repoRoot
python -u agents/daemon_agent.py

