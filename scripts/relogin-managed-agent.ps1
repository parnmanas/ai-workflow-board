# Re-login a managed agent's claude CLI.
#
# agent-manager isolates each agent's claude CLI state under
#   $AWB_AGENT_MANAGER_HOME/agents/<agent_id>/cli-home/
# (default $AWB_AGENT_MANAGER_HOME = %APPDATA%\awb-agent-manager on Windows).
#
# A normal `claude /login` in your shell writes to %USERPROFILE%\.claude\
# .credentials.json — the WRONG place. This script redirects CLAUDE_CONFIG_DIR
# to the per-agent dir, runs the OAuth flow, then verifies the resulting
# token (expiresAt > now, refreshToken non-empty).
#
# Two follow-up paths after this script succeeds:
#   A. Direct injection (what this script does locally): just restart the
#      agent in AWB UI — the file is re-read on every subagent spawn.
#   B. Remote injection: pass -ShowCredential to print the new file content,
#      paste it into AWB Admin -> Credentials -> Claude (Subscription),
#      and attach the credential to the agent. Future renewals can then be
#      done from the AWB UI without shell access to this host.
#
# Usage:
#   pwsh -File scripts/relogin-managed-agent.ps1                 # auto-detect single agent
#   pwsh -File scripts/relogin-managed-agent.ps1 -AgentId <uuid> # explicit
#   pwsh -File scripts/relogin-managed-agent.ps1 -List           # show agents & exit
#   pwsh -File scripts/relogin-managed-agent.ps1 -AgentId <uuid> -ShowCredential

[CmdletBinding()]
param(
  [string]$AgentId,
  [string]$ManagerHome,
  [string]$ClaudeBin,
  [switch]$List,
  [switch]$ShowCredential,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Resolve-ManagerHome {
  param([string]$Override)
  if ($Override) { return (Resolve-Path -LiteralPath $Override).Path }
  if ($env:AWB_AGENT_MANAGER_HOME) { return $env:AWB_AGENT_MANAGER_HOME }
  if ($IsWindows -or $env:OS -eq 'Windows_NT') { return (Join-Path $env:APPDATA 'awb-agent-manager') }
  if ($env:XDG_CONFIG_HOME) { return (Join-Path $env:XDG_CONFIG_HOME 'awb-agent-manager') }
  return (Join-Path $HOME '.config/awb-agent-manager')
}

function Get-AgentEntries {
  param([string]$AgentsDir)
  if (-not (Test-Path -LiteralPath $AgentsDir)) { return @() }
  Get-ChildItem -LiteralPath $AgentsDir -Directory | ForEach-Object {
    $cfgPath = Join-Path $_.FullName 'config.json'
    $entry = [ordered]@{
      AgentId    = $_.Name
      Dir        = $_.FullName
      Name       = '(missing config.json)'
      Cli        = $null
      WorkspaceId = $null
      WorkingDir = $null
    }
    if (Test-Path -LiteralPath $cfgPath) {
      try {
        $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
        $entry.Name        = $cfg.name
        $entry.Cli         = $cfg.cli
        $entry.WorkspaceId = $cfg.workspace_id
        $entry.WorkingDir  = $cfg.working_dir
      } catch { }
    }
    [pscustomobject]$entry
  }
}

function Show-CredentialSummary {
  param([string]$CredentialPath, [string]$Label)
  if (-not (Test-Path -LiteralPath $CredentialPath)) {
    Write-Host "$Label : (not present)"
    return $null
  }
  try {
    $raw = Get-Content -LiteralPath $CredentialPath -Raw
    $obj = $raw | ConvertFrom-Json
  } catch {
    Write-Host "$Label : (file present but not valid JSON)"
    return $null
  }
  $oauth = $obj.claudeAiOauth
  if (-not $oauth) {
    Write-Host "$Label : (file present but no claudeAiOauth field)"
    return $obj
  }
  $expiresMs   = [int64]$oauth.expiresAt
  $expiresUtc  = [DateTimeOffset]::FromUnixTimeMilliseconds($expiresMs).UtcDateTime
  $now         = (Get-Date).ToUniversalTime()
  $expired     = $expiresUtc -le $now
  $rt          = if ([string]::IsNullOrEmpty($oauth.refreshToken)) { 'EMPTY (no auto-refresh)' } else { 'present' }
  $sub         = $oauth.subscriptionType
  Write-Host ("{0} : expiresAt={1:o} ({2}), refreshToken={3}, subscription={4}" -f `
    $Label, $expiresUtc, $(if ($expired) { 'EXPIRED' } else { 'valid' }), $rt, $sub)
  return $obj
}

# ---- main ---------------------------------------------------------------

$home_ = Resolve-ManagerHome -Override $ManagerHome
$agentsDir = Join-Path $home_ 'agents'

Write-Host "agent-manager home : $home_"
Write-Host "agents dir         : $agentsDir"

$entries = Get-AgentEntries -AgentsDir $agentsDir
if ($List -or -not $AgentId) {
  if ($entries.Count -eq 0) {
    Write-Host "No agents found under $agentsDir" -ForegroundColor Yellow
    exit 1
  }
  Write-Host ""
  Write-Host "Agents:"
  $entries | ForEach-Object {
    Write-Host ("  - {0}  name={1}  cli={2}  workspace={3}" -f $_.AgentId, $_.Name, $_.Cli, $_.WorkspaceId)
  }
  if ($List) { exit 0 }
  if ($entries.Count -eq 1) {
    $AgentId = $entries[0].AgentId
    Write-Host ""
    Write-Host "(auto-selecting the only agent: $AgentId — name=$($entries[0].Name))" -ForegroundColor Cyan
  } else {
    Write-Host ""
    Write-Host "Multiple agents present — pass -AgentId <uuid> to pick one." -ForegroundColor Yellow
    exit 1
  }
}

$entry = $entries | Where-Object AgentId -EQ $AgentId | Select-Object -First 1
if (-not $entry) {
  Write-Host "Agent dir not found: $agentsDir\$AgentId" -ForegroundColor Red
  exit 1
}
if ($entry.Cli -and $entry.Cli -ne 'claude') {
  Write-Host "Agent $($entry.Name) uses CLI '$($entry.Cli)', not claude — this script is claude-only." -ForegroundColor Red
  exit 1
}

$cliHome    = Join-Path $entry.Dir 'cli-home'
$credPath   = Join-Path $cliHome '.credentials.json'

Write-Host ""
Write-Host "Selected agent     : $($entry.Name)  ($AgentId)"
Write-Host "Workspace          : $($entry.WorkspaceId)"
Write-Host "CLAUDE_CONFIG_DIR  : $cliHome"
Write-Host ""

if (-not (Test-Path -LiteralPath $cliHome)) {
  Write-Host "cli-home does not exist yet — creating: $cliHome"
  New-Item -ItemType Directory -Path $cliHome -Force | Out-Null
}

Show-CredentialSummary -CredentialPath $credPath -Label 'BEFORE' | Out-Null

if (-not $Force) {
  Write-Host ""
  $reply = Read-Host "Proceed with `claude /login` against the per-agent cli-home? [y/N]"
  if ($reply -notmatch '^[Yy]') {
    Write-Host "Aborted by user."
    exit 0
  }
}

# Resolve claude binary. claude.exe / claude on PATH is the common case;
# allow override via -ClaudeBin. We DON'T touch the agent-manager's own
# cli-resolver here — this is a one-shot user flow.
if (-not $ClaudeBin) {
  $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claudeCmd) {
    Write-Host "claude CLI not found on PATH. Pass -ClaudeBin <path> or install @anthropic-ai/claude-code." -ForegroundColor Red
    exit 1
  }
  $ClaudeBin = $claudeCmd.Source
}

Write-Host "claude bin         : $ClaudeBin"
Write-Host ""
Write-Host "Launching `claude /login` — complete OAuth in your browser, then return here." -ForegroundColor Cyan

$prevDir = $env:CLAUDE_CONFIG_DIR
try {
  $env:CLAUDE_CONFIG_DIR = $cliHome
  & $ClaudeBin /login
  $exitCode = $LASTEXITCODE
} finally {
  $env:CLAUDE_CONFIG_DIR = $prevDir
}

Write-Host ""
if ($exitCode -ne 0) {
  Write-Host "claude /login exited with code $exitCode — verifying credential file anyway." -ForegroundColor Yellow
}

$after = Show-CredentialSummary -CredentialPath $credPath -Label 'AFTER '
Write-Host ""

if (-not $after -or -not $after.claudeAiOauth) {
  Write-Host "No usable .credentials.json was written. Login likely failed." -ForegroundColor Red
  exit 1
}

$oauth = $after.claudeAiOauth
$nowMs  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if ([int64]$oauth.expiresAt -le $nowMs) {
  Write-Host "New token is already expired. Aborting." -ForegroundColor Red
  exit 1
}
if ([string]::IsNullOrEmpty($oauth.refreshToken)) {
  Write-Host "WARNING: refreshToken is empty. The CLI cannot auto-renew this token, so it will expire silently again at the time printed above. Track that date or use a Claude (API Key) credential instead for unattended agents." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Direct method (Method A) — done." -ForegroundColor Green
Write-Host "Restart the agent in AWB so the next subagent spawn picks up the new token:"
Write-Host "  AWB Admin -> Agent Manager -> $($entry.Name) -> Restart"
Write-Host ""

if ($ShowCredential) {
  Write-Host "Remote-injection payload (Method B) — paste into AWB Admin -> Credentials -> Claude (Subscription) -> credentials_json:" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "----- BEGIN credentials_json -----"
  Get-Content -LiteralPath $credPath -Raw
  Write-Host "----- END credentials_json -----"
  Write-Host ""
  Write-Host "After saving the credential, attach it to agent '$($entry.Name)' in AWB Admin -> Agent Manager -> Edit -> CLI credential, then Restart." -ForegroundColor Cyan
} else {
  Write-Host "(re-run with -ShowCredential to also print the JSON for AWB Admin -> Credentials remote injection.)"
}
