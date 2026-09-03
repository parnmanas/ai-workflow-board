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

- **기본 정책은 당분간 `manual` 유지, 목표는 `scheduled`.** 완전 자동을 지금 켜지 않는
  근거는 취향이 아니라 아래 "알려진 사각지대" 3건이다. 셋이 모두 닫힌 뒤에 기본값
  전환을 별도로 판단한다.
- **강제 재시작은 현행 10분 상한을 유지한다.** 상한을 없애면, 카운터가 트리거 세션을
  포함하는 특성상 상시 가동 호스트는 영원히 갱신되지 않는다. 상한이 곧 종결 보장이다.
- **롤백은 "다운그레이드"가 아니라 "부팅 검증 후 이전 버전 재설치"로 정의한다.** 판정
  기준은 재기동 후 하트비트 1회 성공이며, 되돌린 버전에도 provenance 게이트를 그대로
  적용한다(이전 버전이라고 예외를 두지 않는다).
- **정책 스위치는 호스트 로컬 환경변수로 둔다.** 서버 푸시 방식은 SSE contract 변경을
  요구하는데 그만한 이득이 없다. `channel=off` 는 어떤 정책보다 우선하는 하드 핀이다.
- **provenance 는 fail-closed 를 유지한다.** 후속 작업에서도 완화하지 않는다.

### 환경 변수

| 변수 | 상태 | 의미 |
|---|---|---|
| `AWB_AGENT_MANAGER_UPDATE_CHANNEL` | **구현됨** | 추적할 채널 — `latest`(기본) · dist-tag · 정확한 버전 · `off`(현재 빌드 핀). 값별 설명은 `apps/agent-manager/README.md` → "Update channel" 참조 |
| `AWB_AGENT_MANAGER_UPDATE_POLICY` | **미구현(계획)** | `manual`(기본) / `scheduled` / `auto` |
| `AWB_AGENT_MANAGER_UPDATE_WINDOW` | **미구현(계획)** | `HH:MM-HH:MM` 호스트 로컬 유지보수 창, `scheduled` 전용 |

뒤의 둘은 **아직 코드에 존재하지 않는다 — 지금 설정해도 아무 효과가 없다.** 도입은
후속 티켓 소관이며, 도입 시점에도 미설정 기본값은 현행 수동 동작과 동일해야 한다.

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
