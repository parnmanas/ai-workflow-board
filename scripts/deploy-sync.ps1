# Sync production.private to deploy from the current main HEAD. See
# scripts/deploy-sync.sh for the full rationale — this is a PowerShell
# equivalent for Windows users who don't have Git Bash handy.

$ErrorActionPreference = 'Stop'

Set-Location -Path (Join-Path $PSScriptRoot '..')

$origBranch = (git rev-parse --abbrev-ref HEAD).Trim()
try {
  # Dirty tree guard
  $null = git diff-index --quiet HEAD --
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Working tree has uncommitted changes. Commit or stash first."
    exit 1
  }

  Write-Host "-> Fetching origin..."
  git fetch origin main production.private --prune
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host "-> Checking out production.private..."
  git checkout production.private
  git reset --hard origin/production.private

  Write-Host "-> Rebasing production.private onto origin/main..."
  git rebase origin/main
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Error "Rebase hit a conflict. Resolve, then: git rebase --continue (or --abort)."
    exit 1
  }

  $unique = (git log origin/main..HEAD --oneline | Measure-Object -Line).Lines
  if ($unique -ne 1) {
    Write-Error "Expected 1 commit ahead of main, got $unique. Aborting push."
    exit 1
  }
  git cat-file -e "HEAD:.github/workflows/deploy.yml"
  if ($LASTEXITCODE -ne 0) {
    Write-Error "deploy.yml missing after rebase. Aborting push."
    exit 1
  }

  Write-Host "-> Pushing to origin (force-with-lease)..."
  git push --force-with-lease origin production.private

  Write-Host "[OK] production.private rebased onto main and pushed."
}
finally {
  git checkout $origBranch 2>&1 | Out-Null
}
