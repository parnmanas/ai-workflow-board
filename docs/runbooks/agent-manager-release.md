# Agent Manager Release Procedure

**When:** Release procedure for changes under apps/agent-manager (SSE pipeline, subagent supervision, persistent sessions, CLI lifecycle). Use whenever apps/agent-manager/src is modified, and especially when SSE event types are added or changed — those must ship in the same PR as the server side.

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
> 손 범프가 없으니 예전에 운영 교훈 #1 로 기록돼 있던 collapse 클래스(리베이스가
> 동시 티켓의 동일 범프를 충돌 없이 조용히 뭉개 npm 이 stale 해지던 침묵형 실패)도
> **구조적으로** 사라졌다 — 예전의 `check-version-bump.mjs` preflight/CI 잡은 그래서 제거됐다.

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

The same rule covers payload fields of existing events — notably `agent_trigger`'s `status`, `project`, `base_repo.main_clone_dir`, the built-in work order in `column_prompt` and the workspace `harness_config`, and `board_update`'s `status` + status-derived `current_column_*` (a name kept for wire compatibility). The ticket-side contract is [docs/tickets.md](../tickets.md) → "SSE `agent_trigger`"; server payload types live in `apps/server/src/common/types/stream-events.ts` and are mapped field-by-field in `apps/server/src/modules/events/event-registry.ts` (see [field-wiring](field-wiring.md) → "Sibling class").

## Deployment reality check

- Runtime Host 관리 진입점은 사이드바 최상단 **HOSTS** (`/ws/:wsId/hosts`, `admin.access` 필요)다. 매니저 버전 업데이트·재시작, 설치된 CLI 버전·업데이트, ACP 어댑터, 모델 갱신과 페어링을 여기서 관리한다. 기존 `/admin/agent-manager` 주소도 HOSTS로 이동한다. Sessions는 CLI 세션 작업 표면이다.
- P4c-4 업그레이드에서 `runtime_host_identity_required` / `manager_identity_required`가 발생하면 매니저 버전뿐 아니라 **기존 키의 `host_id` 바인딩**도 확인한다. `DropAgentTable1760000000089`는 Agent 테이블을 삭제하기 전에 legacy manager 행과 키를 Host로 보존한다. 이미 이전 코드로 이관이 끝나 Agent 행·키 연결이 사라진 인스턴스는 이 마이그레이션을 다시 실행해도 복원할 정보가 없다. 운영자가 해당 호스트의 `agent.json` 식별자와 `config.json` 키의 SHA-256 해시로 정확한 키를 대조해 기존 식별자의 Host 행과 키 바인딩을 복원하거나 HOSTS에서 재페어링해야 한다. 기존 식별자로 복원하면 저장된 RuntimeSpec 참조를 유지할 수 있다. 설정 파일을 백업하고 `config.json`과 `agent.json`의 `host_id`/`agent_id`를 Host 식별자로 맞춘 뒤 매니저를 재시작한다. 원문 키는 로그나 커밋에 남기지 않는다.

- The AWB server/client **auto-deploys** from `main` (the deploy host re-checks-out `origin/main`, rebuilds and restarts — see README → Production Deployment).
- The **npm package** `awb-agent-manager` **auto-publishes** on every `main` version bump (workflow above) — `npm i -g awb-agent-manager` users get the release once the merge's publish job goes green.
- The agent-manager running **on a host** does **not** auto-deploy, but the Update button works for the **npm-global** install mode — the only distribution channel. It reads `npm view awb-agent-manager@<channel> version` for the check, verifies the published SLSA provenance, then installs the pinned verified version (`npm i -g awb-agent-manager@<version>`) + restarts. **The git-checkout self-update path was removed** — self-update never fetches/builds from a git remote; a build that npm can't reach reads "manual updates only". `AWB_AGENT_MANAGER_UPDATE_CHANNEL` selects the channel (`latest` default · any dist-tag · exact version · `off` to pin, which the badge shows as "(pinned)"). To test an unpublished build, use `npm pack` + `npm i -g ./<tgz>` with the channel set to `off` — never a git checkout (see `apps/agent-manager/README.md` → Update channel).
- When debugging "the fix didn't take effect": grep the *running* agent-manager `dist/` on the host before blaming the new code.

## Field mapping reference (AWB SSE → handlers)

`agent_manager_command`(admin control-surface — spawn/stop/restart 등) payload는 아래 명시적 필드를 그대로 쓴다. `action`/`field_changed`/`actor_name` 별칭 매핑은 **쓰지 않는다** — 그건 다른 이벤트 계열(바로 아래 참조)이다.

| Payload field | Meaning |
|---|---|
| `command_id` | ack 상관관계 id (`POST /api/agent-manager/command/ack`로 echo) |
| `instance_id` | 대상 manager 프로세스 (heartbeat의 `instance_id`와 매치) |
| `agent_id` | manager를 감독하는 Agent row(SSE 필터링용 — 실제 대상 managed agent는 `args.agent_id`) |
| `command` | verb (`CommandKind`) |
| `args` | command별 파라미터 |
| `issued_by` | 발급한 admin의 user_id |
| `issued_at` | ISO-8601 |

정의: `AgentManagerCommandPayload` — `apps/agent-manager/src/lib/agent-manager-commands.ts` (handler 측), `apps/server/src/common/types/stream-events.ts` (server 측, 동일 이름). verb 목록은 하드코딩 나열 대신 그 파일의 `CommandKind`/`KNOWN_COMMANDS`를 근거로 볼 것 — 개수를 여기 적어뒀다가 stale해진 전례가 있다(구 버전 "5 verbs" 표기).

`action`→role / `field_changed`→trigger_id / `actor_name`→agent_id 매핑은 `agent_manager_command`가 아니라 **`agent_trigger`(티켓 dispatch) SSE 계열** 전용이다 — `apps/agent-manager/src/lib/event-dispatcher.ts`의 트리거 처리부(`dispatchTrigger`/`#ackDispatch`) 참조.

Internals: `docs/agent-manager.md`. Quickstart: `apps/agent-manager/README.md`.
