# Voice Operator (음성 대화 · 음성 알림)

AWB 전체를 관리하는 에이전트 하나(**operator**)와 웹·Android 앱에서 **말로 대화**하고, 세션이나
작업이 끝나면 AWB 가 **먼저 말로 알려 주는** 기능의 설계다. 2026-10-04 의 리서치와 결정에서
출발한다 — 벤더·모델·가격은 그날 기준이고 빨리 낡으므로, 구현 직전에 다시 확인한다.

## 결정 (2026-10-04)

| 질문 | 결정 |
|---|---|
| 음성 엔진 | **품질 우선**, 외부 클라우드 전송 허용 |
| 앱 | **Android 먼저**, 가능하면 크로스플랫폼 → Capacitor (기존 React/Vite 클라이언트 재사용, iOS 는 같은 프로젝트에 나중에) |
| operator 두뇌 | **CLI 를 고를 수 있어야 한다** — 실행은 agent-manager 가 맡는다 |

## Claude · Codex 의 음성은 왜 못 쓰는가

- **Claude**: Messages API 에 오디오 입출력이 없다. Claude Code `/voice` 는 받아쓰기 전용이고 claude.ai
  로그인과 **로컬 마이크**가 필요하며 SSH·헤드리스에서는 동작하지 않는다(공식 문서). TTS 는 어디에도 없다.
  AWB 는 CLI 를 Runtime Host 에서 헤드리스(ACP)로 돌리고 마이크는 사용자의 폰에 있으므로 붙일 자리가 없다.
- **Codex**: `/voice`(GPT-Live)는 ChatGPT 로그인일 때 비공개 `chatgpt.com/backend-api` 를 부른다.
  "Sign in with ChatGPT"(2026-10-02)는 오디오 입력·전사 API 를 지원하지 않는다고 명시한다.
  OpenAI 음성 모델을 정식으로 쓰는 길은 Platform API 키(구독과 별도 종량제)뿐이다.

그래서 **음성은 AWB 가 별도 엔진으로 처리하고, CLI 에이전트는 텍스트만 다룬다.**

## 구조

```
[웹 / Android 앱]  마이크 · 재생 큐 · (v2) VAD
   │ ① 발화 오디오 업로드 — 또는 (v2) 서버가 발급한 임시 토큰으로 STT 공급자에 직결 스트리밍
   ▼
[AWB 서버 · modules/voice] ──── STT / TTS 공급자 (Soniox · ElevenLabs · Typecast · Azure · Google · OpenAI 호환)
   │ ② 텍스트 프롬프트 — 기존 Agent Session prompt API 그대로
   ▼
[agent-manager @ operator 호스트] → operator 세션 (Claude Code / Codex / …, 텍스트만 다룬다)
   │ ③ 응답 텍스트 — 기존 agent_session_event 그대로
   ▼
[AWB 서버] → toSpeakable() → TTS → [웹 / 앱] 재생

[서버 이벤트: 세션 턴 종료 · 미션 종료 · 확인 필요 · notify_user]
   → announcer → 말할 문장 → 클립 1회 합성 → SSE / FCM / Telegram
```

### agent-manager 를 오디오 경로에 넣지 않는 이유

1. **알림은 서버 이벤트에서 시작한다.** 앱이 꺼져 있거나 호스트가 꺼져 있어도 서버가 클립을 만들어 보내야 한다.
2. **마이크와 스피커는 단말에 있고, 단말은 서버와만 통신한다.** reverse RPC(SSE↓ + base64 JSON POST↑,
   본문 10MB, op 별 타임아웃)는 제어용이고, AWB 에는 WebSocket 도 없다. 오디오를 매니저로 돌리면 홉만 늘어난다.
3. **음성은 사용자 단위, 매니저는 호스트 단위다.** CLI 가 텍스트만 다루면 agent-manager 코드도, SSE contract 도,
   매니저 재배포도 필요 없다 — "AWB 는 Agent 내부 구현에 의존하지 않는다" 와 같은 방향이다.
4. **선례가 있다.** `services/embedding.service.ts` 가 이미 OpenAI 를 서버에서 직접 부른다(키는 암호화된 SystemSettings).
5. **엔진 교체가 서버 설정 변경으로 끝난다.** 클라이언트에 공급자 SDK 를 박으면 교체가 앱 업데이트가 된다.

agent-manager 가 맡는 것은 **operator 세션의 실행**뿐이다(아래 Operator).

## 엔진

### 공급자 인터페이스

- STT — `transcribe({ audio, mimeType, model, languages, terms }) → text`(발화 하나). 실시간 직결(v2)을 붙일 때
  공급자가 임시 토큰 발급을 추가로 구현한다.
- TTS — `synthesize({ text, voice, model }) → 오디오 바이트`, 그리고 목소리 고르기를 돕는 `listVoices()`(목록 API 가 있는 공급자만).
- 공급자: `soniox`(STT) · `elevenlabs`(STT·TTS) · `typecast`(TTS) · `azure`(TTS) · `google`(TTS) · `openai`(STT·TTS — OpenAI
  본가와 OpenAI 호환 셀프호스팅(ragnar 의 vLLM 등)을 `base_url` 하나로 함께 받는다).
- 키는 SystemSettings `voice.<provider>.*`(암호화 — `embedding.*` 와 같은 방식), 활성 공급자는 `voice.stt.provider` /
  `voice.tts.provider`. 공급자마다 키를 따로 두므로 바꿀 때 키를 다시 넣지 않고, Voice lab 이 등록된 공급자를
  나란히 비교할 수 있다.

### 선정 절차 (bake-off)

품질이 기준이므로 **본인 목소리와 본인 귀로** 정한다. 공개 벤치마크는 낭독체라 한영 혼용과 호스트 이름을 재지 않는다.

| | 후보 | 공개 근거 | 직접 잴 것 |
|---|---|---|---|
| STT | Soniox `stt-rt-v5` · ElevenLabs Scribe v2 · OpenAI 전사 | FLEURS-ko 실시간 CER 4.4 / 4.6 / 6.7(gpt-4o-transcribe) | 명령형 문장 15~20개(영어 용어·rolf/ralf/ragnar 포함), 같은 용어집으로 전사해 비교 |
| TTS | ElevenLabs v4 Turbo · Typecast · Azure ko-KR DragonHD · Google Chirp 3 HD | 한국어 자연스러움 독립 벤치마크 없음 | 같은 문장 20개를 무작위 순서로 듣는 블라인드 테스트 |

- 지연이 상관없는 알림 낭독은 한국어 발음 평판이 좋은 CLOVA Voice 를 따로 볼 수 있다(스트리밍 없음).
- 제외: Supertone(API 2026-08-31 종료), Kokoro(한국어 없음).

## 대화 (STT → operator → TTS)

### 입력

- **v1** — 탭해서 말하고 다시 탭(push-to-talk) → MediaRecorder(Chrome·Android WebView 는 webm/opus, Safari 는 mp4) →
  `POST /api/voice/transcribe`(raw body) → 전사되면 곧바로 보낸다(턴 중이면 큐로, 보낼 수 없는 순간이면 입력창에 남긴다).
- **v2** — 실시간. 서버는 임시 토큰만 발급하고 클라이언트가 공급자에 직결해 말하는 동안 자막을 띄우고,
  공급자의 endpointing 으로 발화 끝을 판정한다. 핸즈프리(VAD: Silero, 턴 판정: Smart Turn)는 v2 위에 얹는다.
- **용어집** — 설정의 고정 용어 + 서버가 붙이는 동적 용어(호스트 이름, 최근 세션·미션 제목). rolf/ralf 처럼
  발음이 거의 같은 이름은 용어집으로도 완전히 못 막는다 → operator 의 확인 규칙으로 막는다(아래).

### 출력

에이전트 응답은 마크다운·코드·UUID 덩어리라 그대로 읽으면 안 된다. 두 겹으로 처리한다.

1. **operator 지침** — 답의 맨 앞에 "말할 2~3문장", 상세는 그 뒤(화면용).
2. **서버 `toSpeakable()`** — 코드 블록·표·URL·UUID·해시 제거/치환, 마크다운 기호 제거, 길이 상한.
   대화·알림·앱이 모두 같은 함수를 지난다(경로마다 규칙이 갈라지면 같은 답이 단말마다 다르게 읽힌다).

- 문장 단위로 끊어 순차 합성·재생한다(다음 문장을 미리 요청) — 첫 소리까지의 지연을 줄인다.
- 한 턴의 텍스트는 도구 호출 사이사이에 끼어 온다. **마지막 도구 호출 뒤의 텍스트**를 최종 답으로 읽는다.
  도구 진행을 짧은 상태음/상태 문구로 알려 긴 턴의 침묵을 메우는 것은 operator 단계(P3)에서 붙인다.
- 재생 규칙: 사용자가 말하기 시작하면 즉시 멈춘다(barge-in). autoplay 는 마이크·읽기 버튼을 누르는 제스처로 재생 요소를
  깨워 둔다(iOS 는 제스처 안에서 한 번 재생된 요소만 나중에 소리를 낸다). 대화 낭독은 **보고 있는(visible) 탭만** 하고,
  화면과 무관한 음성 알림(P2)은 탭이 여러 개일 때 한 탭만 말하도록 리더를 정한다.

## Operator

### 실체 — 고정된(pinned) Agent Session

| | Agent Session (채택) | ChatRoom DM (폐기된 workspace assistant 방식) |
|---|---|---|
| CLI 선택 | 세션 = (Host, CLI) — 그대로 고른다 | runtime identity 로 dispatch |
| 응답 | ACP 스트림 그대로 — 문장 단위 낭독 가능 | `send_chat_room_message` 호출 단위 |
| 위험 작업 확인 | `session/request_permission` 이 사용자에게 릴레이된다 → 음성 확인으로 잇기 쉽다 | 어댑터 tier 로 사전 결정 |
| 기록 | CLI 홈(호스트) | AWB DB |
| 실행 identity | 장비 운영자의 CLI 로그인(구독) | 격리 cli-home |

CLI 선택·권한 릴레이·스트리밍이 이미 있고 chat 모드의 기본 표면이다. 기록이 호스트에 있다는 약점은 operator 를
서버와 같은 상시 장비(rolf)에 두어 상쇄한다. operator 는 admin 전용이다(사이트 권한을 가진 에이전트이므로).

### 설정 (P3 구현)

operator 를 고르는 화면을 따로 만들지 않는다 — **세션을 여는 화면이 이미 Host · CLI · 모델 · 작업 폴더를 고른다**
(새 세션 대화상자의 `RuntimeSelectionFields`, 실행은 agent-manager). 원하는 조합으로 세션을 연 뒤 세션 헤더의
**☆ Operator** 를 누르면 그 세션이 operator 가 된다(admin). 지정과 함께 operator 지침(아래)을 그 세션의 다음
프롬프트로 보낸다. 사이드바 맨 위의 **🎙 OPERATOR** 가 어디서든 그 세션을 연다.

- 저장: SystemSettings 한 행 `operator.session`(JSON: manager_id · cli · session_id · cwd · title · pinned_at · pinned_by).
  Admin Settings 정의 목록에는 넣지 않는다 — 손으로 고칠 값이 아니다(`modules/voice/operator-config.ts`).
- REST: `GET /api/voice/operator`(voice.use) · `PUT` / `DELETE`(admin).
- CLI 를 바꾸려면 다른 CLI 로 세션을 열어 다시 지정한다 — 이전 세션은 세션 목록에 남고, 컨텍스트는 이어지지 않는다.

### 지침 (persona)

지정할 때 보내는 지침(`apps/client/src/voice/operator.ts` `OPERATOR_BRIEF`)의 핵심: 말하기용 요약 먼저 · 삭제/머지/
재시작 같은 위험 작업은 복창 확인 · 발음이 비슷한 이름(rolf/ralf/ragnar)·숫자는 되묻기 · 상세는 화면이나 티켓으로.

첫 프롬프트에만 있는 지침은 컴팩션에 약하므로, 지침은 에이전트에게 작업 폴더의 `AGENTS.md`(+ `@AGENTS.md` 한 줄짜리
`CLAUDE.md`)로 남기게 한다 — Claude Code·Codex·opencode 가 모두 읽고 컴팩션 뒤에도 다시 읽힌다. 단 **그 파일이 없을 때만**
만들게 한다: operator 세션이 저장소 안에서 돌면 그 저장소의 AGENTS.md 를 덮어쓰면 안 된다. 그래서 operator 는 전용 폴더
(예: `~/awb-operator/`)에서 여는 것을 권한다.

### 권한 — 사이트 전체 (P3 구현)

세션의 AWB MCP 는 매니저 키로 주입되고(`apps/agent-manager/src/lib/agent-session-runner.ts` `#defaultMcpServers`),
매니저 키는 페어링 때 한 워크스페이스에 묶인다(`mcp/shared/authz.ts` `callerCanAccessWorkspace`). 그대로면 operator 는
한 워크스페이스만 관리한다.

**operator 로 지정된 세션의 MCP 연결만 그 묶음을 푼다**(`modules/voice/operator-config.ts` `isOperatorConnection`,
`mcp.controller.ts`). 조건은 셋이 다: ① 매니저가 Agent Session 에 주입한 연결(`X-AWB-Client-Type: agent-session`),
② `X-AWB-Session-Id` 가 지정된 operator 세션, ③ 키가 그 operator Host 의 full 키. 풀린 연결은 Host 신원(장비 단위,
워크스페이스 없음)으로 판정된다. 판정은 요청마다 다시 한다 — 이미 열린 MCP 세션도 지정·해제 직후의 요청부터 맞는
범위로 돈다(지정값은 5초 캐시, 지정·해제 때 즉시 버림).

- 이 방식은 agent-manager 를 바꾸지 않는다(SSE contract · 매니저 배포 없음). 처음 생각한 "operator 전용 키를 open RPC 로
  넘기기" 와 신뢰 경계가 같다 — 어느 쪽이든 그 장비의 사용자로 도는 다른 프로세스가 매니저 키를 읽고 같은 헤더를
  만들 수 있다. 그래서 지정은 admin 전용이고, 풀린 연결이 처음 붙을 때 `MCP` 로그를 남긴다.
- 회귀: `apps/server/test/voice-operator-scope.test.mjs`(지정 전 거부 → 지정 후 허용 → 다른 세션은 거부 → 해제 후 거부).

### 먼저 말 걸기

MCP 도구 `notify_user(text, priority)` — operator(또는 다른 에이전트)가 사용자에게 말로 알릴 때. announcer 로 간다.
`docs/runbooks/mcp-tool-wiring.md` 를 따른다(TOOL_AUTHZ_TABLE tier, ticket-ref-capture 분류).

## 음성 알림

### 출처 이벤트 (기본값)

| 이벤트 | 조건 | 대상 | 예 |
|---|---|---|---|
| `agent_session_update` reason `turn_finished` | 턴이 30초 이상, 사용자가 그 세션을 보고 있지 않음 | driver | "롤프 클로드 세션 '배포 스크립트' 작업이 끝났어요." |
| 같은 이벤트, status `awaiting_permission` / `awaiting_input` | — | driver | "… 세션에서 확인이 필요해요." |
| reason `turn_failed` | — | driver | "… 세션이 오류로 멈췄어요." |
| operator 세션 턴 종료 | 대화 화면이 열려 있지 않음 | driver | 응답의 말하기용 요약 |
| `orchestration_update` status `completed` / `failed` / `cancelled` | — | 미션 `created_by` | "미션 '…'이 끝났어요. 12개 중 12개 성공." |
| 미션 사용자 확인 대기 | — | 기존 confirm-notify 수신자 | "미션 '…'에서 확인이 필요해요." |
| `notify_user` | — | 지정 사용자 | 본문 |
| 티켓 완료 · QA/Security/Action 런 완료 | 티켓은 기본 끔, 런은 완료 이벤트부터 신설 | 관여자 | — |

### 전달

| 단말 상태 | 경로 |
|---|---|
| 웹/앱 화면이 켜져 있음 | SSE `voice_announcement`(user-only UI 이벤트 — agent-manager 무관) → 리더 탭이 클립 재생 |
| Android 앱 백그라운드·잠금 | FCM high-priority data → 네이티브 `FirebaseMessagingService` → foreground service(mediaPlayback)가 서명된 클립 URL 을 받아 재생 + 일반 알림 |
| iOS (나중) | APNs `mutable-content` → NSE 가 클립(30초 미만, wav/caf)을 App Group `Library/Sounds` 에 두고 알림음으로 지정 |
| Telegram 연결 사용자 | 기존 UserChannel 경로로 텍스트(선택: 음성 메시지) — AirPods·CarPlay 에서는 Siri 가 읽는다 |

- **클립**: 서버가 한 번 합성해 `AWB_DATA_DIR/voice-clips/` 에 TTL(24h)로 둔다. `GET /api/voice/clips/:id` 는
  사용자 세션 또는 서명 토큰(만료·클립 바인딩 — 로그인 세션이 없는 네이티브 서비스용)으로 연다.
- **중복 억제**: announcement id 하나는 단말당 한 번. 화면이 켜진 단말이 있으면(최근 30초 내 visible 하트비트)
  푸시는 소리 없이 보낸다.
- **사용자 설정**: 카테고리별 on/off · 조용한 시간 · 말하기 속도. 푸시 판단이 서버에서 일어나므로 서버에 둔다.

### Android 주의

- targetSdk 36 에서 FCM → foreground service 재생은 허용된다(high-priority 메시지가 시작을 허가한다. 우선순위가
  강등되면 시작이 던지므로 `getPriority()` 를 먼저 본다).
- Android 17 의 백그라운드 오디오 강화는 targetSdk 37 부터 FCM 이 띄운 서비스의 재생을 묵음 처리할 수 있다(미검증) —
  Play 가 37 을 요구하기 전에 대안을 검증한다.
- 알림 채널의 소리는 채널을 만든 뒤 고정된다 → 메시지별 음성을 채널 소리로 실을 수 없다.
- 오디오 포커스는 transient-may-duck 으로 잡는다(음악을 줄였다가 되돌린다).

## 앱 (Capacitor, Android 먼저)

- `apps/mobile` — Capacitor 프로젝트. WebView 는 배포된 AWB(`server.url`)를 그대로 띄운다 → UI 변경은 서버 배포로
  따라오고, 앱 업데이트는 네이티브 부분(FCM, 재생 서비스, 권한)이 바뀔 때만 필요하다.
- 네이티브: FCM 토큰 등록(`POST /api/me/devices`), `FirebaseMessagingService` + 재생 서비스, 마이크 권한(WebView getUserMedia 허용).
- 서버: `user_devices` 엔티티(배럴 export 와 `MIGRATION_ENTITY_ORDER` 등록을 같은 커밋에), FCM HTTP v1 발송(서비스 계정).
- 빌드: GitHub Actions(ubuntu 러너에 Android SDK 포함)에서 APK 를 만든다. 개인 사용은 사이드로드로 충분하고 Play 등록은 선택이다.
- iOS 는 같은 프로젝트에 나중에 붙인다(NSE 타깃 추가, Apple Developer 계정 필요).

## 단계

| 단계 | 산출물 | 끝났다고 보는 기준 |
|---|---|---|
| P1 음성 게이트웨이 + 웹 대화 | `modules/voice`(공급자 · 설정 · 전사 · 합성 · `toSpeakable`), Agent Session 컴포저 마이크 + 응답 낭독, Voice lab | 세션 화면에서 말로 묻고 답을 듣는다. Voice lab 으로 엔진을 확정한다 |
| P2 음성 알림 (웹 · Telegram) | announcer, `voice_announcement`, 클립 캐시, 사용자 설정, 아래 공백 메우기 | 다른 화면에 있을 때 세션 종료 · 미션 종료를 말로 듣는다 |
| P3 operator | 세션 고정(☆ Operator) · 사이드바 진입점 · 지침 · 사이트 전체 권한. 남은 것: `notify_user`(턴 도중 먼저 말 걸기) | 웹·앱 어디서든 operator 를 불러 사이트 작업을 시킨다 |
| P4 Android 앱 | `apps/mobile`, 디바이스 등록, FCM, 재생 서비스 | 폰이 잠겨 있어도 작업 종료를 말로 듣고, 앱에서 operator 와 대화한다 |
| P5 (선택) | iOS, 실시간 음성 프런트(GPT-Live client delegation), wake word | — |

## P1 구현 — 음성 게이트웨이 + 세션 음성 대화

| 층 | 무엇 | 위치 |
|---|---|---|
| 설정 | SystemSettings `voice.*` — 활성 공급자(`voice.stt.provider` / `voice.tts.provider`), 모델·목소리·언어·용어집, 공급자별 키(암호화). 정의는 voice 모듈이 갖고 Admin Settings 가 펼친다. 저장하면 설정 캐시를 즉시 버린다 | `modules/voice/voice-config.ts` |
| 공급자 | STT: soniox(실시간 WebSocket 에 발화 하나를 흘린다) · elevenlabs(Scribe) · openai(호환 서버 포함). TTS: elevenlabs · typecast · azure · google · openai | `modules/voice/providers/*` |
| 낭독 정리 | `toSpeakable()`(코드·표·URL·식별자 제거, 경로는 마지막 조각) + `splitSpeakable()`(문장 경계 조각, 첫 조각은 짧게) | `modules/voice/speakable.ts` |
| REST (`voice.use`, 기본 admin) | `GET /api/voice/config` · `POST /api/voice/transcribe`(raw 오디오 본문) · `POST /api/voice/speakable` · `POST /api/voice/speech` | `modules/voice/voice.controller.ts` |
| REST (admin) | Voice lab — `POST /api/voice/lab/transcribe?provider=` · `POST /api/voice/lab/speech` · `GET /api/voice/lab/voices?provider=` | 같은 파일 |
| 화면 — 세션 | 컴포저 🎙(탭 → 말 → 탭: 전사 후 바로 전송, 턴 중이면 큐), 헤더 "Read aloud"(턴이 끝나면 최종 답 낭독). **말로 물은 답은 Read aloud 가 꺼져 있어도 읽는다**(voice in → voice out). 녹음을 시작하면 낭독을 멈춘다(barge-in). 보고 있는(visible) 화면에서만 읽고, 세션 화면을 떠나면 멈춘다 | `components/sessions/*`, `voice/*` |
| 화면 — Admin → Voice | 엔진 설정 + STT 비교(같은 발화를 모든 공급자에, 정답을 적으면 CER) + TTS 블라인드 테스트(문장마다 다시 섞은 A/B/C, 평점 뒤 공개, "Use this voice") | `components/admin/VoicePage.tsx` |

- 한 턴의 "읽을 답" 은 마지막 도구·권한·질문·plan 뒤의 텍스트 덩어리다(`voice/turnAnswer.logic.ts`). 답 뒤에
  정리용 도구로 끝난 턴은 비어 있지 않은 마지막 덩어리를 읽고, 사용자가 멈춘(cancelled) 턴은 읽지 않는다.
- 공급자가 꺼져 있거나 이름이 틀렸거나 키가 없으면 409 + 사유다. 다른 공급자로 넘어가지 않는다. 공급자의
  401/403 도 409(운영자가 고칠 설정), 그 밖의 실패는 502, 시간 초과는 504.
- Soniox 는 발화 하나를 실시간 WebSocket 에 `audio_format: "auto"` 로 흘린다. auto 형식 목록에 webm(Chrome ·
  Android WebView 녹음)은 있지만 **mp4 컨테이너(iOS Safari 녹음)는 없다** — iOS 단계에서 확인하고, 안 되면 그때 변환이나
  비동기 API 를 붙인다. ElevenLabs Scribe · OpenAI 는 mp4/m4a 를 받는다.
- 회귀: `apps/server/test/voice-{speakable,gateway,http}.test.mjs`, `apps/client/test/voice-{turn-answer,lab}.test.mjs`.

## P2 구현 — 음성 알림 (웹)

| 층 | 무엇 | 위치 |
|---|---|---|
| 감지 | `VoiceAnnouncerService` 가 activity 이벤트를 듣는다 — `agent_session_update`(turn_finished · turn_failed · 권한/질문 대기), `agent_session_event`(답의 첫머리를 모은다), `orchestration_update` 의 `last_event.type`(mission_completed · mission_failed · mission_cancelled · confirm_notified) | `modules/voice/voice-announcer.service.ts` |
| 문장 | 템플릿(ko/en — `voice.stt.languages` 첫 언어). 답·요약이 있으면 `toSpeakable` 로 160자까지 덧붙인다. 조사는 고정 명사 뒤에만 단다(제목 받침과 무관하게 맞게) | `modules/voice/announcement-text.ts` |
| 대상 | 세션 → driver. 미션 → 사람이 만들었으면 그 사람, 에이전트가 만들었으면 워크스페이스 owner(소리는 member 전원까지 넓히지 않는다) | 같은 서비스 |
| 발행 | SSE `voice_announcement`(user-only, 받는 사용자만 — agent-manager 무관). TTS 가 준비되지 않았으면 보내지 않는다 | `event-registry.ts` |
| 소리 | `GET /api/voice/announcements/:id/audio` — 받는 사람만, **처음 요청될 때 한 번** 합성(듣는 화면이 없으면 엔진을 부르지 않는다). 메모리에 2시간 | `voice.controller.ts` |
| 화면 | `VoiceAnnouncer`(AppLayout, 모든 화면): 알림 설정 "Speak work updates"(단말별, 기본 켬)가 켜져 있으면 토스트(누르면 그 화면) + 소리. 탭이 여럿이면 **먼저 집은 한 탭만**(Web Locks + localStorage 표시, 숨은 탭은 700ms 양보). **보고 있는 세션의 알림은 말하지 않는다**(그 화면이 이미 답을 읽는다). 대화 낭독을 끊지 않고 줄을 서고, 말하기 시작하면 줄까지 비운다 | `voice/VoiceAnnouncer.tsx`, `voice/announcements.ts`, `voice/speechPlayer.ts` |

- 기준: 턴이 **30초 이상** 걸렸을 때만 알린다(시작을 못 봤으면 긴 것으로 친다). 사용자가 멈춘 턴은 알리지 않고, 오류는 길이와
  무관하게 알린다. 같은 세션의 "확인 필요" 는 1분에 한 번.
- "읽을 답" 규칙의 서버 사본(`modules/voice/turn-answer.ts`)은 화면 규칙과 같아야 한다 —
  `apps/client/test/voice-turn-answer.test.mjs` 가 두 구현을 같은 입력으로 돌린다.
- 회귀: `apps/server/test/voice-announcer.test.mjs`, `voice-http.test.mjs`(SSE 전달 · 소리 소유권),
  `apps/client/test/voice-announcements.test.mjs`.
- 남은 것: 브라우저가 꺼져 있으면 들을 곳이 없다 → Android 앱(P4)의 푸시. Telegram 전달은 그 전에 필요해지면 붙인다.

## 메워야 할 공백 (2026-10-04 코드 기준)

- ~~작업 종료가 어떤 알림으로도 나가지 않는다~~ — P2 의 음성 알림이 세션·미션 종료를 다룬다(토스트 포함). 외부 채널(Telegram 등)로는 아직 안 나간다.
- `agent_session_update` 는 driver 가 있을 때만 발행된다(`agent-sessions.service.ts` `emitUpdate`) — 서버 재시작 뒤
  세션을 다시 열기 전에는 종료를 놓친다.
- `orchestration_update` 에 소유자 필드가 없다 — announcer 는 `OrchestrationMission.created_by` 를 직접 읽는다.
- QA · Security · Action 런은 완료 SSE 가 없다.
- 디바이스 푸시와 PWA 가 없다.
- 세션 턴의 최종 텍스트가 조립돼 있지 않다 — `text` 델타를 `turn_id` 로 잇는다(`sessionTranscript.logic.ts` 와 같은 규칙).

## 계약 · 규칙

- `voice_announcement` 는 user-only UI 이벤트다(`orchestration_update` 와 같은 패턴) → agent-manager contract 무관.
- operator 의 사이트 전체 권한은 서버 쪽 판정이다 — agent-manager contract 무관. (전용 키를 open RPC 로 넘기는 방식으로 바꾸면 그때는 `agent_session_request` contract 가 바뀐다 → server · agent-manager 같은 PR.)
- 새 엔티티는 배럴 export + `MIGRATION_ENTITY_ORDER` 한 쌍. 새 테스트는 등록(client `package.json`, server `test/suites/*.txt`).

## 비용 감 (2026-10-04 정가)

하루 1시간 말하고 1시간 듣는 경우: STT Soniox 약 $4/월, TTS ElevenLabs v4 Turbo 약 $30/월(한국어 분당 ~400자 가정)
또는 Azure HD 약 $16/월. 알림 클립은 무시할 수준이다.
