---
name: awb-agent-manager-release
description: Release procedure for changes under apps/agent-manager (SSE pipeline, subagent supervision, persistent sessions, CLI lifecycle). Use whenever apps/agent-manager/src is modified, and especially when SSE event types are added or changed — those must ship in the same PR as the server side.
---

# Agent Manager Release Procedure

`apps/agent-manager/` is a standalone Node binary (`awb-agent-manager`) that owns the SSE pipeline (`EventStream` → `EventDispatcher`), subagent supervision (`SubagentManager`), persistent ticket/chat sessions, fs-browser reverse-RPC, heartbeat, and the agent lockfile.

## Procedure (in order)

1. Modify `apps/agent-manager/src/`.
2. Verify `npm run build` passes **from the workspace root** (turbo builds the whole monorepo — a green agent-manager-only build is not enough).
3. Commit + push. **버전을 손으로 범프하지 마라** — publish 시점에 자동 계산된다(아래).

> **버전은 publish 시점에 자동 계산된다 (ticket 433f6cbd, source c17a8a40).**
> 변경이 `main` 에 랜딩하면 `.github/workflows/publish-agent-manager.yml` 이
> `apps/agent-manager/scripts/compute-publish-version.mjs` 로 **레지스트리 최신값 + patch** 를 계산해
> 그 버전으로 npm publish 하고 `awb-agent-manager-v<version>` 태그를 남긴다.
> `apps/agent-manager/package.json` 의 `version` 은 이제 **'최초 배포 seed floor'**
> 로만 쓰이고(이미 npm 에 올라간 뒤엔 참조 안 됨) 손으로 올릴 필요가 없다.
> 손 범프가 없으니 board lesson #1 의 collapse 클래스(리베이스가 동시 티켓의 동일
> 범프를 충돌 없이 조용히 뭉개 npm 이 stale 해지던 침묵형 실패)도 **구조적으로**
> 사라졌다 — 예전의 `check-version-bump.mjs` preflight/CI 잡은 그래서 제거됐다.

> **npm publish 는 자동이고, 릴리스 태그·버전을 손으로 밀지 마라.** 변경이 `main`
> 에 랜딩하는 게 릴리스 트리거다(트리거는 version diff 가 아니라 agent-manager
> 산출물/publish 기계 변경 — `paths` 필터). 계산된 버전은 main 에 **되커밋하지
> 않고** 태그/tarball 에만 담으므로 봇 push→재트리거 루프가 없다. 두 전제는
> Parn/infra 쪽: `NPM_TOKEN` repo secret 이 **2FA bypass** 켜진 **Automation**
> 토큰이어야 하고, 변경이 실제로 `main` 에 닿아야 한다(bc306b8d 의 1.0.0-stuck
> 은 트리거 자체가 없던 경우). 재실행은 **멱등**하다 — 이미 올라간 버전이면 태그만
> 보장하고, 부분 실패(publish 됐는데 태그만 실패)는 다음 run 이 npm 의 gitHead
> provenance(배포 당시 커밋 SHA)로 복구한다.

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
