#!/usr/bin/env bash
# Sync the production.private branch to deploy from the current main HEAD.
#
# Shape invariant: production.private = main + exactly one commit that adds
# .github/workflows/deploy.yml. We maintain this by REBASING, not merging:
#
#   - merge-from-main would see "main deleted deploy.yml" vs "our branch
#     didn't touch it" and delete the file (it's been deleted on main in
#     5674cbb by design — deploy infra lives only on production.private).
#     Every such merge then needs a restore commit, and forgetting that
#     step breaks the deploy.
#
#   - rebase-onto-main replays our single deploy.yml commit on top of the
#     latest main, which just recreates the file. No 3-way merge, no
#     footgun.
#
# Push is force-with-lease (safer than --force) because rebase rewrites SHAs.
# production.private is a personal deploy branch — no collaborators base
# work on it — so rewriting history here is fine.

set -euo pipefail

cd "$(dirname "$0")/.."

# Remember where we started so we can return the user to their branch.
ORIG_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
cleanup() {
  git checkout "$ORIG_BRANCH" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Fail loudly if the working tree isn't clean — rebase on dirty state is
# a recipe for lost work.
if ! git diff-index --quiet HEAD --; then
  echo "✗ Working tree has uncommitted changes. Commit or stash first." >&2
  exit 1
fi

echo "→ Fetching origin..."
git fetch origin main production.private --prune

echo "→ Checking out production.private..."
git checkout production.private
git reset --hard origin/production.private

echo "→ Rebasing production.private onto origin/main..."
if ! git rebase origin/main; then
  echo
  echo "✗ Rebase hit a conflict. This should be rare — production.private is"
  echo "  supposed to be a single 'add deploy.yml' commit on top of main."
  echo "  Resolve the conflict, then run: git rebase --continue"
  echo "  (Or abort with: git rebase --abort)"
  exit 1
fi

# Make sure the invariant still holds.
UNIQUE="$(git log origin/main..HEAD --oneline | wc -l | tr -d ' ')"
if [ "$UNIQUE" != "1" ]; then
  echo "✗ Expected exactly 1 commit ahead of main, got $UNIQUE. Aborting push." >&2
  echo "  Inspect with: git log origin/main..HEAD" >&2
  exit 1
fi
if ! git cat-file -e HEAD:.github/workflows/deploy.yml 2>/dev/null; then
  echo "✗ deploy.yml missing after rebase. Aborting push." >&2
  exit 1
fi

echo "→ Pushing to origin (force-with-lease)..."
git push --force-with-lease origin production.private

echo "✓ production.private rebased onto main and pushed."
echo "  GitHub Actions 'Deploy AI Workflow Board' should trigger shortly."
