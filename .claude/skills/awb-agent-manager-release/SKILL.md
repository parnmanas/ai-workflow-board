---
name: awb-agent-manager-release
description: Release procedure for changes under apps/agent-manager (SSE pipeline, subagent supervision, persistent sessions, CLI lifecycle). Use whenever apps/agent-manager/src is modified, and especially when SSE event types are added or changed — those must ship in the same PR as the server side.
---

# Agent Manager Release Procedure

`apps/agent-manager/` is a standalone Node binary (`awb-agent-manager`) that owns the SSE pipeline (`EventStream` → `EventDispatcher`), subagent supervision (`SubagentManager`), persistent ticket/chat sessions, fs-browser reverse-RPC, heartbeat, and the agent lockfile.

## Procedure (in order)

1. Modify `apps/agent-manager/src/`.
2. Verify `npm run build` passes **from the workspace root** (turbo builds the whole monorepo — a green agent-manager-only build is not enough).
3. **Bump `version` in `apps/agent-manager/package.json`.**
4. Commit + push.

> **버전 collapse 게이트 (ticket c17a8a40).** 동시 진행 티켓이 같은 다음 버전으로
> 범프한 뒤 내 브랜치를 리베이스하면 git 이 그 범프를 충돌 없이 조용히 collapse
> 시킨다(board lesson #1 — 3회 재발). 이제 자동 방어가 두 겹이다:
> - **머지 preflight (권장, 랜딩 전 차단):** 리베이스 직후
>   `node apps/agent-manager/scripts/check-version-bump.mjs --preflight` 를 실행하라.
>   `origin/main` 을 fetch 한 뒤, agent-manager `src/` 를 건드린 브랜치인데 version 이
>   `origin/main` 보다 크지 않으면 **exit 1** 로 막는다. 예전의 수동
>   `git show origin/main:… | grep version` 눈대중을 대체한다.
> - **CI 게이트 (백스톱, 랜딩 후 자동 검출):** `.github/workflows/ci.yml` 의
>   `agent-manager version bump guard` 잡이 push→main / PR 마다 같은 검사를 돌려,
>   collapse 가 랜딩하면 main 을 즉시 red 로 만든다 → 재범프로 해소.

> **npm publish is automatic — do NOT hand-push a release tag.** When the version
> bump lands on `main`, `.github/workflows/publish-agent-manager.yml` publishes
> that exact version to npm (idempotent: a no-op if already published) and records
> the `awb-agent-manager-v<version>` tag for you. Two preconditions live on the
> Parn/infra side: the `NPM_TOKEN` repo secret must be a valid **Automation** token
> with **2FA bypass enabled**, and the bump must actually reach `main` (the merge
> is the release trigger). Skip the bump → npm silently falls behind the repo —
> that is the exact 1.0.0-stuck failure of ticket bc306b8d (only 1.0.0 ever got a
> tag, so 1.0.1–1.6.16 never published).

## SSE contract rule

If you add or change an **SSE event type**, the server side (`apps/server/src/modules/agent-manager/`) must change **in the same PR**. The agent-manager and the AWB server consume the same contract; splitting the two halves across PRs ships a window where one side speaks a dialect the other doesn't understand.

## Deployment reality check

- The AWB server/client **auto-deploys** from the production branch.
- The **npm package** `awb-agent-manager` **auto-publishes** on every `main` version bump (workflow above) — `npm i -g awb-agent-manager` users get the release once the merge's publish job goes green.
- The agent-manager running **on a host** does **not** auto-deploy, but the Update button works for **both** install modes (ticket 9c9b52eb): a git-checkout install self-updates from `origin/main` (git pull + build + re-exec), and an npm-global install self-updates from the npm registry (`npm view` for the version check, then a detached helper runs `npm i -g awb-agent-manager@latest` + restart). Only a vendored/`unknown` build still reads "manual updates only". Bootstrap caveat: a host must first be on the version that ships this feature (≥ the bump in this ticket) before its npm-global Update button appears — older npm-global installs still show "manual updates only" and need one manual `npm i -g awb-agent-manager@latest`.
- When debugging "the fix didn't take effect": grep the *running* agent-manager `dist/` on the host before blaming the new code.

## Field mapping reference (AWB SSE → handlers)

| SSE field | Handler meaning |
|---|---|
| `action` | role |
| `field_changed` | trigger_id |
| `actor_name` | agent_id |

Internals: `docs/agent-manager.md`. Quickstart: `apps/agent-manager/README.md`.
