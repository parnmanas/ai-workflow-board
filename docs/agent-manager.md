# Runtime Host (`awb-agent-manager`)

`awb-agent-manager` is AWB's host-side execution service. The package, binary,
configuration directory, and HTTP routes keep their existing names for
compatibility, but the architectural role is **Runtime Host**, not an
independent Agent and not an agent hierarchy.

## AWB entity references

User-visible Ticket, Agent, Board, Action, Function, and Schedule references use
`#[type:<full-uuid>|Human-readable name]`, never a shortened ID alone. MCP
results expose the canonical token as `_ref`; use that value in chat, comments,
and Run results. See [entity-references.md](entity-references.md) for resolution,
context, and fallback rules.

The Runtime Host owns the resources that must live on an execution machine:

- the authenticated SSE/REST connection to AWB;
- one isolated working environment and credential boundary per AWB Agent;
- runtime process lifecycle, cancellation, recovery, and health reporting;
- delivery of immutable skill snapshots;
- protocol adapters, including Hermes over ACP stdio;
- bounded ChildRun telemetry for runtime-native collaboration.

AWB remains the control plane. It owns Agent identity, authorization, work
state, audit history, runtime selection, collaboration policy, and governed
skills.

See [Hermes runtime](hermes-runtime.md) for Hermes installation and policy
examples.

## Identity model

| Concept | Lifetime | Purpose |
|---|---|---|
| Runtime Host | machine/process | Executes configured runtimes and reports capabilities |
| AWB Agent | durable database identity | Owns responsibilities, permissions, assignments, and history |
| Hermes ChildRun | bounded child of one parent run | Performs temporary delegated or swarm work |

A ChildRun is never promoted to an AWB Agent. Create another AWB Agent only
when the participant needs durable responsibility, separate authorization, an
independent queue, or long-lived history.

Every executable Agent must have:

1. a `manager_agent_id` identifying its Runtime Host;
2. an explicit runtime id (`type`);
3. an explicit `runtime_config`.

There is no default runtime, default strategy, or fallback to an editor/plugin
session. A missing, unknown, unavailable, or invalid runtime fails with a
typed error instead of silently changing execution semantics.

## Host topology

```text
AWB server (control plane)
  ├─ Agent/runtime configuration
  ├─ events, permissions, audit, skills
  └─ Runtime Host API + SSE
             │
             ▼
awb-agent-manager (execution plane)
  ├─ capability heartbeat
  ├─ managed Agent isolation
  ├─ classic CLI adapters
  └─ Hermes ACP process owner
       ├─ one process per durable AWB Agent
       ├─ resumable session per AWB run
       └─ bounded ChildRuns
```

The historical package/API label `agent-manager` is therefore a compatibility
alias. New UI and documentation should say **Runtime Host**.

## Installation and pairing

```bash
npm i -g --ignore-scripts awb-agent-manager
awb-agent-manager setup
awb-agent-manager service install
```

`--ignore-scripts` 는 self-update 가 쓰는 것과 같은 플래그다. provenance 게이트는
**우리 tarball** 의 출처만 보증하고, 그 아래 전이 의존성은 설치 시점 레지스트리에서
새로 해석되므로 그중 하나가 postinstall 을 달고 있으면 CVE 없이도 이 호스트에서
임의 코드가 돈다. 발행 트리의 install-script 패키지는 0개이고
(`scripts/audit-published-deps.mjs` 가 매일 재확인), bin 링크는 lifecycle script 가
아니라 npm 코어 동작이라 이 플래그로 잃는 것이 없다.

The setup flow redeems a one-time pairing token created in **Admin → Runtime
Hosts** and writes host configuration under `$AWB_AGENT_MANAGER_HOME` (or the
platform configuration directory).

Useful commands:

```bash
awb-agent-manager --version
awb-agent-manager --dry-run
awb-agent-manager service install --dry-run
awb-agent-manager service uninstall
```

## Runtime selection contract

Runtime ids currently registered by the host are `claude`, `deepseek`,
`codex`, `antigravity`, `pi`, and `hermes`. Only Hermes is owned through the
ACP process supervisor; the others keep their explicit CLI adapter path.

```json
{
  "strategy": "single",
  "permission_mode": "strict",
  "profile": "optional-runtime-profile",
  "max_children": 3,
  "max_iterations": 3,
  "extra": {}
}
```

- `strategy`: `single`, `delegated`, or `swarm`. Non-Hermes runtimes currently
  support only `single`.
- `permission_mode`: `strict`, `approve`, or `trusted`.
- `profile`: optional runtime-native model/profile name.
- `max_children` and `max_iterations`: bounded collaboration budgets.
- `extra`: runtime-specific policy such as child depth, concurrency, tools,
  and skills.

The server validates the same contract as the host. This prevents invalid
configurations from being stored and protects execution if old or manually
edited data reaches the host.

### Permission tier → CLI flags (ticket 5851e435)

`runtime_config.permission_mode` (Agent trust) is the **source of truth** for
execution privilege on every runtime, not just Hermes. The board/workspace
harness `permission_mode` is a second, older layer; the two are folded into one
effective policy by `resolveEffectivePermissionPolicy()`
(`apps/agent-manager/src/lib/permission-policy.ts`), which every dispatch entry
point shares — ticket, chat, mention, Action/QA run and orchestration all reach
the CLI through `SubagentManager.spawn` or `BaseSessionManager`, and both
resolve the policy the same way.

**Precedence**: Agent trust > harness > manager default (`trusted`).

- Agent trust set → it decides the tier. The harness can no longer lower it, so
  a `trusted` agent never loses its max-privilege flag (and therefore never
  falls back onto Claude's interactive workspace-trust dialog). Within the same
  tier the harness still picks the exact CLI mode string.
- Agent trust unset (legacy agent) → the harness string decides, exactly as
  before this ticket: unset/unrecognised/`bypassPermissions` → `trusted`,
  `plan` → `strict`, `acceptEdits`/`auto`/`default`/`dontAsk`/`manual` →
  `approve`.
- Agent trust **present but unrecognised** (corrupt config, hand-edited row, a
  newer server sending a tier this manager does not know) → fails **closed** to
  `strict` with `source: invalid_trust`, never to the harness or the `trusted`
  default. The server validates this field on write, so a value reaching the
  manager unrecognised already means a contract violation; raising privilege on
  it would be exactly backwards. The spawn itself is not refused — `strict` is
  already the defined minimum-privilege/deny path, so a one-character typo
  degrades the run instead of wedging the ticket.

| runtime | `trusted` | `approve` | `strict` |
| --- | --- | --- | --- |
| `claude`, `deepseek` | `--dangerously-skip-permissions` | `--permission-mode acceptEdits` | `--permission-mode plan` |
| `codex` | `--dangerously-bypass-approvals-and-sandbox` | `--sandbox workspace-write -c approval_policy="never"` | `--sandbox read-only -c approval_policy="never"` |
| `antigravity` | `--dangerously-skip-permissions` | flag omitted (approximated) | flag omitted (approximated) |
| `pi` | `--approve` | flag omitted (approximated) | flag omitted (approximated) |
| `hermes` | ACP permission requests auto-allowed | ACP request bridged to the AWB approval path (the only `native` approve) | ACP request cancelled |

Each runtime declares how faithfully it expresses a tier via
`permissionCapabilities()` (adapter side) and `RuntimeCapabilities.permission_tiers`
(reported to AWB on the instance heartbeat, so the gap is visible to an operator
and not only in a log line). The two come from the same constants and a
regression test enforces that they agree.

**`approve` is `native` only on Hermes, and is BLOCKED elsewhere.** The
requested meaning of `approve` is "raise an approval request to AWB", which is
implemented by `RuntimeSupervisor.#requestApproval` over ACP
`session/request_permission`. `claude --print` and `codex exec` expose no
equivalent hook, so they cannot raise any approval at all — a tool call needing
permission is simply denied without asking.

Labelling that honestly (`approve: 'approximated'`) is necessary but not
sufficient: running anyway would still silently turn the operator's "a human
approves" into "denied without asking". So `decideApproveDispatch()` **refuses
the spawn** whenever the effective tier is `approve` and the runtime reports
`native_approvals: false`. On the ticket path the dispatcher posts one
de-duplicated operator comment and pends the ticket
(`approve_requires_approval_bridge` is a durable blocker); on ticket-less paths
(chat, mention, Action/QA runs) `SubagentManager.spawn` and
`BaseSessionManager` refuse with the same reason.

This does not contradict "Pending only for a real human-approval gate" — it
*is* one: the runtime cannot ask, so a person must decide. The comment names the
three exits: set trust to `trusted` (grant), to `strict` (deny), or move the
agent to a `native_approvals` runtime. The admin runtime-config form warns about
the same combination before it is saved, using the reported
`permission_tiers`.

This is deliberately a loud stop rather than a quiet downgrade, including for
agents whose `approve` came from the `BackfillAgentRuntimeConfig` migration
default: each affected agent gets one explicit operator decision instead of a
silent change in what its trust level means.

`antigravity`/`pi` have no per-tier option at all, so `approve`/`strict` are
approximated by dropping their auto-approve flag (both run non-interactively, so
this restricts rather than hangs).

A partially reported or unknown-valued `permission_tiers` is dropped whole by the
server rather than partially accepted — otherwise a missing tier is
indistinguishable from "unsupported". A manager that does not report the field
at all leaves it `undefined`; the server never invents a default, and the admin
UI shows no warning for a runtime it has no report for.

`permission_tiers` is carried end to end: agent-manager `RuntimeCapabilities` →
instance heartbeat → server `RuntimeCapabilityDescriptor` → the
`agent_manager_instance` stream payload → the client `RuntimeHealth` type → the
managed-agent runtime-config form.

Pending is never created for a CLI-internal permission/trust dialog. Claude's
workspace-trust preflight (ticket 48aeab6e) now blocks only when the board
harness explicitly asked for a non-bypass mode **and** Agent trust did not
override it to `trusted` — an agent whose trust alone is `approve`/`strict` on
a board that never configured a harness is not gated.

The effective policy and the spawned argv are written to the manager log on
every spawn. Argv redaction decides by **position, then schema** — never by the
shape of the token:

- A token immediately after a value-taking flag is a *value*, even if it starts
  with `-`. Deciding "starts with `-` ⇒ flag" is bypassed the moment a prompt
  begins with `--`, and `antigravity`/`pi` put the prompt straight into argv.
- In value position only a closed enum passes: `--permission-mode`,
  `--sandbox`, `--output-format`, `--input-format`, `--effort`, and
  `-c approval_policy="…"`. Anything not in the enum is reduced to `<Nch>`.
  `--model` is deliberately *not* loggable — a model id is free text a CLI
  validates itself, so it cannot be told apart from `sk-…` by format; the model
  is already carried by the separate Agent-context / model-chain log lines.
- Outside value position, only known flag names and an explicit literal
  allowlist (`exec`) render verbatim. An unrecognised `-…` token is treated as a
  value and masked.
- Secret-shaped tokens are replaced with `<redacted>` anywhere and do not even
  leak a length.

The effective-policy line is subject to the same rule. A rejected Agent trust
value is arbitrary input that may itself be a token, so it is never quoted back:
the log carries `len=<N> sha256=<8hex>` (correlation only, not a secrecy
guarantee) and the raw string is not kept on the policy object at all.

## Capability and health reporting

The Runtime Host heartbeat advertises each runtime's protocol, session mode,
MCP support, approval support, cancellation/steering support, usage reporting,
collaboration strategies, and skill-delivery modes. Scheduling must use this
live capability report; it must not infer availability from a runtime name.

For Hermes, a successful ACP `initialize` handshake is the health probe. A
`swarm` run is rejected if the probe is not healthy and is never downgraded.

## Process and session ownership

- Hermes has exactly one isolated ACP process per durable AWB Agent.
- Each AWB run maps to one Hermes session with an Agent id and lease id.
- Restore requires the same Agent and lease.
- Cancel interrupts work but retains the recovery mapping.
- Close removes the mapping. ACP implementations without the optional
  `session/close` extension are supported.
- Stop/restart removes the process owner and on-disk ownership marker.
- Startup cleanup terminates orphaned processes owned by a dead Runtime Host.

## Security boundaries

- API keys and credentials remain scoped to the managed Agent.
- Hermes stdout is reserved for ACP JSON-RPC; diagnostics use stderr.
- MCP requests include Agent id, AWB run id, client type, and strategy.
- Skill files are materialized privately after digest verification.
- ChildRun metadata and summaries are bounded and secret-sanitized.
- ChildRuns cannot perform terminal ticket transitions, consensus actions, or
  skill publication.

## Durable send outbox

Chat replies, silent-exit audit comments, and dispatch/command acknowledgements
that fail while AWB is temporarily unreachable are persisted to
`$AWB_AGENT_MANAGER_HOME/outbox.json`. The Runtime Host rehydrates this FIFO
queue at startup and retries it when SSE reconnects, with a 60-second periodic
backstop for isolated REST failures.

Only retryable transport failures and HTTP 5xx, 408, or 429 responses enter the
queue. Other 4xx responses are permanent failures. Time-sensitive progress,
output-liveness, and filesystem-response traffic is never buffered.

| Kind | Source | TTL |
|---|---|---|
| `chat_message` | Real `postChatRoomMessage` replies; progress heartbeats excluded | 24h |
| `silent_exit_comment` | `postSilentExitSystemComment` | 24h |
| `dispatch_ack` | `postDispatchAck`, deduplicated by `trigger_id` server-side | 15min |
| `command_ack` | `postCommandAck` | 1h |

Delivery is at-least-once and FIFO. A flush stops at the first retryable
failure, entries are persisted after every queue mutation, and the queue is
capped at 500 entries by dropping the oldest. A corrupt outbox is discarded
without blocking Runtime Host startup. Replay calls transport-only `*Raw`
senders so a failed replay cannot enqueue a duplicate copy of itself.

## Self-update policy

self-update 는 npm-global 설치 모드에서만 동작한다. 아래는 현재 구현된 동작과, 그
위에서 확정된 운영 정책이다. 정책의 근거와 위험 분석 전문은 티켓
`c9a06971-ac78-4332-95d1-fddd30b14c2d` 의 decision 코멘트에 있다.

### 현행 동작 (구현됨)

| 단계 | 동작 | 근거 |
|---|---|---|
| 감지 | `UpdateChecker` 가 5분마다 `npm view awb-agent-manager@<channel> version` 을 읽어 `update_available` 을 **광고만** 한다 | `self-update.ts` → `#tickNpmGlobal()` |
| 개시 | **설치를 스스로 시작하지 않는다.** 외부 트리거(관리자 UI 의 `update_manager` 명령 또는 `SIGUSR1`)가 있어야 한다 | `agent-manager-commands.ts`, `main.ts` |
| 공급망 검증 | 대상 버전의 SLSA provenance 를 확인하고 증명이 없으면 **설치를 거부한다**(fail-closed) | `self-update.ts` → `parseProvenanceView()` |
| drain | 진행 중 chat/action/QA/ticket 세션이 있으면 설치를 연기하고, 주기 tick 이 재시도한다 | `self-update.ts` → `evaluateNpmUpdateGate()` |
| 강제 재시작 | 연기가 벽시계 10분(`SELF_UPDATE_DRAIN_MAX_WAIT_MS`)을 넘으면 남은 세션을 `reason=self_update_restart` 로 태그하고 강행한다 | 같은 함수 |
| 재기동 | 분리된 임시 헬퍼가 매니저 종료를 기다렸다가 `npm i -g` 후 재기동한다 | `NPM_GLOBAL_UPDATER_SOURCE` |

drain 카운터는 **트리거를 건 세션 자신을 포함한다**(`main.ts` 의
`countInFlightSessions`). 에이전트가 스스로 갱신을 트리거하면 보통 `deferred` 가 먼저
뜨고 최대 10분 뒤에 설치되는 것이 정상 경로다 — 실패로 오판하지 말 것.

### 확정된 정책

- **기본 정책은 당분간 `manual` 유지, 목표는 `scheduled`(예약 승인형).** 완전 자동을
  지금 켜지 않는 근거는 취향이 아니라 아래 "알려진 사각지대" 3건이다. 셋이 모두 닫힌
  뒤에 기본값 전환을 별도로 판단한다.
- **`scheduled` 는 창이 오면 설치하는 것이 아니라, 창이 오면 승인을 요청하는 것이다.**
  유지보수 창은 *언제 물어볼지*를 정하지 *언제 무인 실행할지*를 정하지 않는다. 승인 없이
  창 안에서 개시하는 방식은 `auto` 이며, 그쪽이 티켓이 말한 "완전 자동"이다. 상세는 아래
  "승인 게이트" 참조.
- **강제 재시작은 현행 10분 상한을 유지한다.** 상한을 없애면, 카운터가 트리거 세션을
  포함하는 특성상 상시 가동 호스트는 영원히 갱신되지 않는다. 상한이 곧 종결 보장이다.
- **롤백은 "다운그레이드"가 아니라 "부팅 검증 후 이전 버전 재설치"로 정의한다.** 판정
  기준은 재기동 후 하트비트 1회 성공이며, 되돌린 버전에도 provenance 게이트를 그대로
  적용한다(이전 버전이라고 예외를 두지 않는다).
- **재시도는 bounded 여야 한다.** 무한 재시도와 "같은 불량 버전 재설치 루프"를 둘 다
  금지한다. 실패 지점별 상한은 아래 "재시도·핀 정책" 참조.
- **정책 스위치는 호스트 로컬 환경변수로 둔다.** 서버 푸시 방식은 SSE contract 변경을
  요구하는데 그만한 이득이 없다. `channel=off` 는 어떤 정책보다 우선하는 하드 핀이다.
- **provenance 는 fail-closed 를 유지한다.** 후속 작업에서도 완화하지 않는다.

### 승인 게이트 (`scheduled` 전용)

| 항목 | 결정 |
|---|---|
| 승인 주체 | 기존에 `update_manager` 명령을 낼 수 있는 workspace admin. **새 권한 축을 만들지 않는다** |
| 승인 단위 | **(호스트 × 대상 버전) 1회성.** 한 호스트에서 v1.6.185 를 승인해도 v1.6.186 이나 다른 호스트에는 적용되지 않는다 |
| 요청 시점 | 유지보수 창에 진입했고, 실제로 새 버전이 있고, provenance 검증을 통과했을 때 |
| 미승인 시 | **아무 일도 일어나지 않는다.** 요청은 다음 창에 다시 표면화된다. 시간이 지난다고 무인 실행으로 승격되지 않는다 |
| 승인 후 | 기존 경로 그대로 — drain → 10분 상한 → 설치 → 재기동 |

`auto` 는 이 게이트를 건너뛴다. 아래 사각지대 3건이 닫히기 전에는 어느 호스트에서도 켜지
않는다.

**요청 전달 경로는 아직 없다 — 만들지 않으면 `scheduled` 는 `manual` 과 동작이 같다.**
지금 매니저가 사람에게 "승인해 달라"고 알릴 수단이 없다. 매니저→서버 방향의 승인 요청
채널이 없고(하트비트에 `update_available` 을 싣는 것이 전부인데 그건 `manual` 도 이미 한다),
유일한 표면은 관리자 UI 의 Update 버튼이라 **누군가 그 페이지를 열어야** 보인다. 능동 알림도
없다 — `ManagerDriftMonitorService` 는 임계 초과 시 로그와 `activity_logs` 행만 남기고
의도적으로 Discord/SSE fan-out 을 하지 않는다. 따라서 전달 경로를 만들기 전까지 `scheduled`
는 "창 안에서만 배지가 뜨는 `manual`" 에 불과하다. **전달 경로 구현은 `scheduled` 도입과
같은 범위에 묶는다** — 동작하지 않는 정책값을 먼저 내보내지 않는다.

**채택된 설계의 알려진 비용**: 승인을 버전에 묶었으므로 **매 릴리스마다 사람의 행위가
필요하다.** 즉 "아무도 승인하지 않아 호스트가 조용히 뒤처지는" 실패 모드가 `scheduled`
에서도 남는다. 이것이 `auto` 를 영구히 배제하지 않는 이유이며, 사각지대 3건이 닫히면
호스트별 opt-in 으로 `auto` 를 여는 선택지가 계속 열려 있어야 하는 이유다.

### 재시도·핀 정책

| 실패 지점 | 자동 재시도 | 상한 | 소진 후 |
|---|---|---|---|
| 설치 실패 (`npm install -g` 가 비-0 종료) | 있음 | 같은 창 안에서 최대 2회 추가, 백오프 5분 → 15분 | 창을 벗어나면 중단. 한 버전에서 누적 3회 실패하면 그 버전을 실패로 표시하고 자동 시도를 멈춘다 |
| 부팅 실패 (설치는 성공했으나 새 빌드가 하트비트 1회 성공에 실패) | **없음** | — | 즉시 이전 버전으로 복귀하고 그 버전으로 핀한다. 같은 버전을 다시 설치하지 않는다 |

부팅 실패에 재시도를 두지 않는 이유는 단순하다 — 재시도가 곧 불량 버전 재설치 루프다.
같은 이유로 **핀 해제는 사람만 한다.** 자동 해제 경로를 두면 루프가 되살아난다. 어느
경로에서도 무한 재시도는 없다.

**상한을 셀 곳이 지금은 없다 — 영속 상태가 정책의 전제다.** 설치는 분리된 헬퍼가 수행하고,
부모 프로세스는 헬퍼를 spawn 한 뒤 **설치가 시작되기도 전에 종료한다**(`detached` spawn +
`unref()`, 헬퍼는 부모 pid 가 사라지길 기다렸다가 설치). `runSelfUpdate` 의 반환값도
성공/실패가 아니라 "scheduled" 다. 결과를 아는 것은 헬퍼뿐인데 헬퍼는 결과와 무관하게
매니저를 재기동한 뒤 자신을 지운다. 되살아난 프로세스는 **이전 시도가 있었다는 사실 자체를
모른다.** 따라서 위 상한은 재-exec 을 넘어 보존되는 상태
(`{대상 버전, 누적 실패 횟수, 핀 사유}`, 예: `$AWB_AGENT_MANAGER_HOME` 아래 파일)를 요구한다.
이 상태가 없으면 상한은 코드에만 존재하고 실제 동작은 무한 재시도가 된다.

### 환경 변수

| 변수 | 상태 | 의미 |
|---|---|---|
| `AWB_AGENT_MANAGER_UPDATE_CHANNEL` | **구현됨** | 추적할 채널 — `latest`(기본) · dist-tag · 정확한 버전 · `off`(현재 빌드 핀). 값별 설명은 `apps/agent-manager/README.md` → "Update channel" 참조 |
| `AWB_AGENT_MANAGER_UPDATE_POLICY` | **구현됨** | `manual`(기본, 외부 트리거만) / `scheduled`(창에서 승인 요청 → 승인 시 개시) / `auto`(창 안에서 승인 없이 개시). 모르는 값은 `manual` 로 떨어진다 |
| `AWB_AGENT_MANAGER_UPDATE_WINDOW` | **구현됨** | `HH:MM-HH:MM` 호스트 로컬 유지보수 창(자정 넘김 지원). `scheduled` 와 `auto` 가 함께 쓴다 |

**기본값은 `manual` 이고, 두 변수를 설정하지 않으면 동작은 이 기능 도입 전과 동일하다.**
정책 전환(어느 호스트에 `auto` 를 켤지)은 운영자 판단이며, 아래 사각지대가 닫히기 전에는
무인 재시작을 켜지 않는 것이 전제다.

우선순위는 고정이다: `AWB_AGENT_MANAGER_UPDATE_CHANNEL=off` > `policy=manual` > 새 버전
없음 > 창 미설정 > 창 밖 > 창 안. 즉 **`off` 는 `auto` 여도 이기는 하드 핀**이고, 창을
설정하지 않은 `scheduled`·`auto` 는 보수적으로 `manual` 과 똑같이 동작한다.

창은 *언제 물어볼지*를 정하지 *언제 무인 실행할지*를 정하지 않는다 — `scheduled` 는 창
안에서 **승인을 요청만** 하고, 운영자가 `update_manager` 를 낼 때까지 아무것도 설치하지
않는다. 요청은 **대상 버전의 발행 provenance 를 통과한 뒤에만** 나가며(fail-closed),
요청하는 버전은 그 검증이 해석한 정확한 버전이다 — 검증 대상과 승인 대상이 어긋나면
승인이 의미를 잃는다. 같은 이유로 승인으로 개시하는 설치는 채널을 다시 해석하지 않고
**승인된 그 버전으로 고정**한다(복귀 핀이 걸려 있으면 그쪽이 우선). 승인은 **(호스트 × 대상 버전) 1회성**이라 다음 릴리스에는 다시 요청한다. 요청은
하트비트의 `update_approval_pending_version` 으로 서버에 실려 `activity_logs` 감사행
(`agent_manager_update_approval_requested`)으로 남으므로, 관리자가 대시보드를 열지 않아도
확인할 수 있다.

### 알려진 사각지대

1. **설치 성공 후 기동 실패에 대한 자동 복귀 경로가 없다.** 헬퍼는 `npm install -g` 가
   *실패*했을 때만 디스크에 남아 있는 이전 빌드로 되돌아간다. 설치가 성공한 뒤 새 빌드가
   부팅에서 죽는 경우를 되돌릴 장치는 없다.
2. **죽은 매니저가 대시보드에서 정상으로 보인다.** 하트비트가 끊기면 인스턴스가
   레지스트리에서 스윕되는데, `ManagerDriftMonitorService` 는 인스턴스 부재를 드리프트
   "해소"로 기록한다. 즉 나쁜 빌드로 fleet 이 죽는 순간 경보가 아니라 해소가 찍힌다.
3. **self-update 로 끊긴 세션의 재개가 보장되지 않는다.** `DispatchReconcilerService` 는 role
   holder 가 컬럼 진입 이후 응답한 적이 있으면 그 role 을 재시드하지 않는다. 착수 직후
   claim + 코멘트를 남기는 관례상, 장시간 작업 중 죽은 세션이 정확히 이 조건에 걸린다.

## Troubleshooting

| Error | Meaning | Operator action |
|---|---|---|
| `runtime_not_configured` | Agent has no explicit runtime | Select a runtime and save its config |
| `runtime_unknown` | Runtime id is not registered | Correct the Agent type or deploy a supporting host |
| `runtime_unavailable` | Runtime cannot start/probe | Check heartbeat, executable, credentials, and PATH |
| `runtime_config_invalid` | Strategy/permission/bounds are invalid | Correct the runtime configuration |
| `runtime_collaboration_denied` | Child exceeded policy | Inspect depth/concurrency/tool/skill allowlists |
| `acp_timeout` | Hermes did not answer in time | Check Hermes stderr, provider health, and host load |
| `acp_process_exited` | Hermes terminated | Check Runtime Host logs and provider credentials |
| `acp_malformed_message` | stdout was not ACP JSON-RPC | Send wrapper diagnostics to stderr |

Protocol-level smoke check:

```bash
hermes acp --check
hermes acp --version
```

Use Hermes-native UIs only for runtime diagnostics. AWB is the authoritative
project UI because it owns the work graph, identities, permissions, skills,
and audit trail.
