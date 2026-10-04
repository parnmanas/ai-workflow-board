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

### 설정 — 여러 operator, 이름 (P3 구현)

operator 를 고르는 화면을 따로 만들지 않는다 — **세션을 여는 화면이 이미 Host · CLI · 모델 · 작업 폴더를 고른다**
(새 세션 대화상자의 `RuntimeSelectionFields`, 실행은 agent-manager). 원하는 조합으로 세션을 연 뒤 세션 헤더의
**☆ Operator** 를 누르고 **이름**을 붙이면 그 세션이 operator 가 된다(admin). 등록과 함께 operator 지침(아래)을 그
세션의 다음 프롬프트로 보낸다. operator 는 **여러 개** 둘 수 있다(예: rolf 의 Claude "자비스", ragnar 의 Codex
"프라이데이") — 사이드바 맨 위의 **OPERATORS** 가 어디서든 각 세션을 연다.

- 이름은 부르는 말(웨이크워드)이다. 음성 인식이 이름을 다른 철자로 적을 수 있어(`Jarvis` → `자비스`) **별칭**을 함께
  둔다. 이름·별칭은 operator 끼리 겹칠 수 없다(대소문자·공백·문장부호 무시, 409 `operator_name_taken`). 등록
  대화상자의 **🎙 불러 보기** 가 "헤이 <이름>" 을 실제 엔진으로 받아 적어 보고, 이름이 다르게 적히면 그 철자를 별칭으로
  더한다 — 키워드 모델 학습 대신 이 확인이 인식률을 정한다.
- 저장: SystemSettings 한 행 `operator.sessions`(JSON 배열: id · name · aliases · manager_id · cli · session_id · cwd · title ·
  created_at · created_by · updated_at). 한 개만 두던 시절의 `operator.session` 은 처음 읽을 때 이름 "Operator"(별칭
  "오퍼레이터")로 옮기고 지운다 — 이름을 바꿔 쓴다. Admin Settings 정의 목록에는 넣지 않는다(`modules/voice/operator-config.ts`).
- REST: `GET /api/voice/operators`(voice.use) · `POST` / `PATCH /:id` / `DELETE /:id`(admin). 세션 주소는 바꾸지 않는다 —
  다른 세션이면 새로 등록한다. 읽고-고치고-쓰기는 한 줄로 세운다(`updateOperators`).
- operator 이름·별칭은 **모든 전사의 용어집에 더한다**(`VoiceService.transcribe`) — 엔진이 등록한 철자로 적게.
- Admin → Voice 의 **Operators** 카드가 목록을 보여 주고 이름·별칭을 고치거나, 장비에서 사라진 세션의 등록을 푼다.
- CLI 를 바꾸려면 다른 CLI 로 세션을 열어 등록한다 — 이전 세션은 세션 목록에 남고, 컨텍스트는 이어지지 않는다.

### 지침 (persona)

등록할 때 보내는 지침(`apps/client/src/voice/operator.ts` `operatorBrief(name)`)의 핵심: 그 이름으로 불린다는 것 ·
말하기용 요약 먼저 · 삭제/머지/재시작 같은 위험 작업은 복창 확인 · 발음이 비슷한 이름(rolf/ralf/ragnar)·숫자는 되묻기 ·
상세는 화면이나 티켓으로 · **대화를 마치면 답 끝에 `[[sleep]]`**(아래 "이름 부르기 · 잠들기"). 이름을 바꿨거나 긴 세션에서
지침이 흐려졌으면 등록 대화상자의 "지침 다시 보내기".

첫 프롬프트에만 있는 지침은 컴팩션에 약하므로, 지침은 에이전트에게 작업 폴더의 `AGENTS.md`(+ `@AGENTS.md` 한 줄짜리
`CLAUDE.md`)로 남기게 한다 — Claude Code·Codex·opencode 가 모두 읽고 컴팩션 뒤에도 다시 읽힌다. 단 **그 파일이 없거나
예전 operator 지침 파일(첫 줄에 "AWB Operator 지침")일 때만** 쓰게 한다: operator 세션이 저장소 안에서 돌면 그 저장소의
AGENTS.md 를 덮어쓰면 안 되고, 예전 지침 파일은 새로 써야 이름·잠들기 규칙이 따라온다. 그래서 operator 는 전용 폴더
(예: `~/awb-operator/`)에서 여는 것을 권한다.

### 권한 — 사이트 전체 (P3 구현)

세션의 AWB MCP 는 매니저 키로 주입되고(`apps/agent-manager/src/lib/agent-session-runner.ts` `#defaultMcpServers`),
매니저 키는 페어링 때 한 워크스페이스에 묶인다(`mcp/shared/authz.ts` `callerCanAccessWorkspace`). 그대로면 operator 는
한 워크스페이스만 관리한다.

**operator 로 등록된 세션의 MCP 연결만 그 묶음을 푼다**(`modules/voice/operator-config.ts` `isOperatorConnection`,
`mcp.controller.ts`). 조건은 셋이 다: ① 매니저가 Agent Session 에 주입한 연결(`X-AWB-Client-Type: agent-session`),
② `X-AWB-Session-Id` 가 등록된 operator 세션 중 하나, ③ 키가 그 operator Host 의 full 키. 풀린 연결은 Host 신원(장비 단위,
워크스페이스 없음)으로 판정된다. 판정은 요청마다 다시 한다 — 이미 열린 MCP 세션도 지정·해제 직후의 요청부터 맞는
범위로 돈다(지정값은 5초 캐시, 지정·해제 때 즉시 버림).

- 이 방식은 agent-manager 를 바꾸지 않는다(SSE contract · 매니저 배포 없음). 처음 생각한 "operator 전용 키를 open RPC 로
  넘기기" 와 신뢰 경계가 같다 — 어느 쪽이든 그 장비의 사용자로 도는 다른 프로세스가 매니저 키를 읽고 같은 헤더를
  만들 수 있다. 그래서 지정은 admin 전용이고, 풀린 연결이 처음 붙을 때 `MCP` 로그를 남긴다.
- 회귀: `apps/server/test/voice-operator-scope.test.mjs`(등록 전 거부 → 등록 후 허용 → 다른 세션은 거부 → 두 번째 operator 도
  허용 → 하나를 해제하면 그 하나만 거부), `voice-operators.test.mjs`(옛 단일 값 이전 · 이름 충돌 · 겹친 쓰기).

### 이름 부르기 · 잠들기 (2026-10-04)

"헤이 <이름>" 하고 부르면 그 operator 가 깨어나고, 깨어 있는 동안은 이름 없이 이어서 말한다. 대화를 마치는 말이
나오면 operator 가 알아듣고 다시 잠든다.

```
잠듦 ─ 사이드바 OPERATORS 👂 on ─▶ 상시 청취(WakeListener: VAD → /voice/transcribe?purpose=wake → matchWake)
  │                                         │ "헤이 자비스, 오늘 배포 상태 알려줘"
  │                                         ▼  신호음 ↑ · 그 세션 화면으로 이동
  │                              깨어 있음: 대화 모드가 스스로 켜지고 "오늘 배포 상태 알려줘" 가 첫 요청으로 간다
  │                                         │ 이름 없이 계속 대화(답은 탭이 숨어 있어도 읽는다)
  └──── 신호음 ↓ ◀── operator 답 끝의 [[sleep]] 을 다 읽은 뒤 · 60초 조용 · 💤/🎙 끄기 · 화면 이탈
```

- **확인은 글자로 한다.** 키워드 모델(openWakeWord · Porcupine)은 이름마다 따로 학습해야 해서 "이름을 마음대로" 와 맞지
  않는다. 잠든 동안 들린 발화마다 셀프호스팅 STT(ragnar Qwen3-ASR, 한 발화 ~0.2초)로 받아 적고 맨 앞이 부르는
  말인지 본다(`apps/client/src/voice/wake.logic.ts` `matchWake`): 앞머리(헤이 · hey · 하이 · 오케이 · 야 …) + 이름, 또는
  이름 + 부름 조사(…야 · …아). 대소문자·공백·문장부호를 무시하고, 한글은 **소리 나는 대로** 자모로 풀어(받침과 초성을
  같은 자음으로, 묵음 ㅇ 은 빼고, ㅐ/ㅔ 같은 모음은 하나로) 이름 길이에 비례하는 만큼만 틀려도 같은 이름으로 본다 —
  실측으로 ragnar ASR 이 용어집 없이 "자비스" 를 **"잡이스"** 로 적었다(연음, 같은 소리). 이름은 낱말 경계에서 끝나야 하고,
  문장 중간·이야기("자비스 진짜 좋다")는 부름이 아니다.
- **이름만 한 발화는 부름이 아니다.** Qwen3-ASR 은 짧은 잡음이나 말의 앞부분에 대해 문맥으로 준 용어집을 그대로 읊는다
  (실측: "헤이 자비스" 앞 1.5초 → "자비스, Jarvis."). 이름 단독을 받으면 기침 한 번에 깨어난다. 서버도 용어 둘 이상만으로 된
  전사를 메아리로 보고 버린다(`isVocabularyEcho`, 응답 `ignored: 'vocabulary_echo'`; Voice lab 은 날것 그대로).
- **상시 청취는 셀프호스팅 STT 에서만** 받는다(`?purpose=wake`, 아니면 409 `voice_wake_needs_self_hosted`, `/voice/config` 의
  `wake.ready`). 깨어 있지 않은 동안 마이크 근처의 모든 말이 엔진으로 가므로, 비용이 들고 대화가 바깥으로 나가는
  클라우드 엔진에서는 켜지 않는다.
- **단말마다 켠다**(localStorage `awb.voice.wake`, 사이드바 OPERATORS 머리의 👂). 한 단말에서는 한 탭만 듣는다(Web Lock
  `awb-voice-wake-listener`). 탭이 숨어 있어도 듣는다 — 켜 둔 단말을 스피커처럼 쓰는 것이 이 기능의 쓰임새다. 무엇을
  읽는 동안은 쉬고, 대화 모드가 마이크를 쓰는 동안(`wakeStore.claimMic`)은 마이크를 열지 않는다. 브라우저는 사용자
  동작 전에는 소리 처리를 막으므로, 새로고침 직후에는 화면을 한 번 누르면 시작한다(상태 `tap`).
- **잠들기는 operator 가 정한다.** "고마워" 같은 낱말로 화면이 추측하지 않는다 — "고마워, 그리고 하나 더" 를 끝으로
  읽으면 안 된다. 지침이 "대화를 마치는 말이면 짧게 인사하고 답 맨 끝에 `[[sleep]]`" 을 가르치고, 화면은 그 표시를 떼어
  읽은 뒤(낭독 정리 `toSpeakable` 도 지운다) 잠든다. 긴 세션에서 지침이 요약돼 사라져도 규칙이 남도록 깨어난 뒤 첫 요청
  앞에 안내 한 줄(`WAKE_PROMPT_NOTE`)을 붙이고, 화면은 그 줄을 떼고 "🎙 불러서 시작" 으로 보여 준다.
- 그 밖에 잠드는 경우: 답을 기다리거나 읽는 동안이 아닌데 60초 조용(`WAKE_IDLE_SLEEP_MS`), 💤 잠들기 또는 🎙 끄기,
  그 operator 화면을 떠남(마지막 화면이 닫히면 한 틱 뒤 — React 개발 모드의 붙였다 떼기를 견디게), 깨어났는데
  10초 안에 화면이 열리지 않음.
- 깨어 있는 동안 다시 이름을 부르면 이름만 떼고 보낸다. **다른 operator 를 부르면 그쪽이 깨어난다**(화면 이동).
  군소리("음", "어")는 보내지 않는다 — "네" 는 확인 대답이라 보낸다.
- 검증: 헤드리스 Chromium 가짜 마이크에 ragnar TTS 로 만든 "헤이 자비스." / "오늘 배포 상태 알려줘." / "고마워, 이제 됐어." 를
  넣고 실제 ragnar ASR 로 — 듣기 시작 1.6초 → 이름 인식 216ms → 깨어나 세션 화면·대화 모드까지 0.3초 → 첫 요청(안내 한 줄
  포함) 전송 → 두 번째 말은 답 뒤로 큐 → `[[sleep]]` 답에 잠듦 → 다시 "Hey, 자비스." 로 깨어남.
- 회귀: `apps/client/test/voice-wake.test.mjs`(부르는 말 · 메아리 · 철자 틀림 · 잠들기 표시 · 탭 상태),
  `apps/server/test/voice-gateway.test.mjs`(메아리), `voice-http.test.mjs`(purpose=wake 거절/허용, 용어집의 이름).
- 남은 것: 앱(P4)에서는 화면이 꺼져 있어도 들어야 한다 — 브라우저 탭으로는 안 되고 네이티브 서비스(Foreground Service +
  같은 VAD/전사 경로)가 맡는다.

### 먼저 말 걸기

MCP 도구 `notify_user(text, priority)` — operator(또는 다른 에이전트)가 사용자에게 말로 알릴 때. announcer 로 간다.
`docs/runbooks/mcp-tool-wiring.md` 를 따른다(TOOL_AUTHZ_TABLE tier, ticket-ref-capture 분류).

## 음성 알림

### 작업 보고 — 세션 소식은 operator 가 전한다 (2026-10-04)

세션마다 따로 말하지 않는다. AWB 를 거쳐 연결된 세션(driver 가 있는 Agent Session)의 턴이 끝나거나(오류 포함)
사용자의 승인·답을 기다리면, **AWB 가 그것을 알아채 operator 에게 보고**하고, operator 가 쓴 요약이 사용자에게
소리(+토스트)로 간다. 말하는 것은 operator 하나다.

```
세션 턴 종료 · 오류 · 승인/질문 대기 (agent_session_update/event — 서버가 이미 안다)
   │  사용자가 그 세션 화면을 보고 있으면 끝 (VoicePresenceService — 화면이 30초마다 알린다)
   ▼
OperatorReportService: 받을 operator = 같은 호스트(여럿이면 최근 대화) → 없으면 가장 최근에 대화한 operator
   │  바쁘면(사용자와 대화 중) 줄 세웠다가 한가해지면 묶어서 한 번에
   ▼
operator 세션에 대신 보낸 프롬프트 "[AWB 작업 보고] … 1. 완료 — rolf / Codex · '배포 정리' · 12분 …"
   ▼  (operator 가 1~2문장 요약)
voice_announcement kind `operator_report`(+ operator 이름) → 토스트 "🎙 자비스: …" + 낭독, 누르면 그 세션으로
```

- **감지는 AWB 가 한다(MCP 자가보고가 아니다).** 턴 종료·승인 대기는 AWB 가 이미 정확히 알고, 승인 대기로 멈춘
  세션은 MCP 도구를 부를 수도 없으며, 에이전트마다 "끝나면 보고해" 를 지키길 기대할 수 없다.
- 받을 operator 는 `routeOperators()`(`modules/voice/operator-report.ts`). "대화" 는 사용자가 시작한 operator 턴이다 —
  AWB 가 보낸 보고 턴은 세지 않는다. 시각은 `OperatorEntry.last_conversation_at` 에 1분 간격으로 남는다(재시작 뒤에도).
- 보고는 `AgentSessionsService.promptOnBehalf()` — 화면이 보낸 것처럼 driver 의 라이브 전사에 프롬프트 행도 흘린다.
  워크스페이스는 등록 때 화면의 것(`OperatorEntry.workspace_id`, 그 워크스페이스의 CLI 설정·credential 로 연다).
  전사는 보고 프롬프트를 "📋 AWB 작업 보고 · n건" 으로 접는다.
- **조용히 버리지 않는다.** operator 에게 닿지 못하면(호스트 꺼짐) 다음 후보로, 아무도 안 되거나 operator 가 보고 턴을
  실패·10분 무응답하면, 승인·질문 보고가 바쁜 operator 를 2분 넘게 기다리면(요청은 15분이면 취소된다), 나머지는
  20분 넘게 기다리면 — 아래 템플릿 문장으로 직접 알린다. 등록된 operator 가 없으면 예전처럼 직접 알린다.
- operator 자신의 턴은 보고하지 않는다. 사용자가 그 operator 화면을 떠나 있을 때 끝난 대화 턴은 operator 의 답 자체를
  들려준다(`operator_reply`). operator 가 사용자의 승인을 기다리면 직접 알린다.
- 같은 답을 두 번 읽지 않는다: 세션 화면은 **자기가 보낸 턴만** 읽고(보고 턴은 알림이 읽는다), 깨어 있는 대화를 맡은
  화면은 탭이 숨어도 "보고 있음" 으로 알린다(그 답은 화면이 읽는다).
- operator 는 보고만 보고 다른 세션에 일을 시키거나 승인하지 않는다(지침) — 사용자가 세션 화면에서 답하거나, 말로
  지시한다. 말로 승인까지 대신하게 하는 도구는 아직 없다.
- 회귀: `apps/server/test/voice-operator-reports.test.mjs`(라우팅 · 보고 문장 · 요약 전달 · 보고 있음 · 바쁨/묶음 ·
  다음 후보 · 직접 알림으로 되돌리기 · operator 자신의 턴 · 화면과의 계약).

### 출처 이벤트 (기본값)

| 이벤트 | 조건 | 대상 | 예 |
|---|---|---|---|
| 세션 턴 종료·오류·승인/질문 대기 | 사용자가 그 세션을 보고 있지 않음 | driver | **operator 의 요약**(위 "작업 보고"). operator 가 없으면: "롤프 클로드 세션 '배포 스크립트' 작업이 끝났어요."(턴 30초 이상) · "… 세션에서 확인이 필요해요." · "… 세션이 오류로 멈췄어요." |
| operator 세션 턴 종료 | 그 operator 화면을 보고 있지 않음 | driver | operator 의 답(`operator_reply`) |
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
| P3 operator | 이름 붙은 operator 여러 개(☆ Operator) · 사이드바 진입점 · 지침 · 사이트 전체 권한 · 이름 부르기/잠들기. 남은 것: `notify_user`(턴 도중 먼저 말 걸기) | 웹·앱 어디서든 operator 를 불러 사이트 작업을 시킨다 |
| P4 Android 앱 | `apps/mobile`, 디바이스 등록, FCM, 재생 서비스 | 폰이 잠겨 있어도 작업 종료를 말로 듣고, 앱에서 operator 와 대화한다 |
| P5 (선택) | iOS, 실시간 음성 프런트(GPT-Live client delegation) | — |

## P1 구현 — 음성 게이트웨이 + 세션 음성 대화

| 층 | 무엇 | 위치 |
|---|---|---|
| 설정 | SystemSettings `voice.*` — 활성 공급자(`voice.stt.provider` / `voice.tts.provider`), 모델·목소리·언어·용어집, 공급자별 키(암호화). 정의는 voice 모듈이 갖고 Admin Settings 가 펼친다. 저장하면 설정 캐시를 즉시 버린다 | `modules/voice/voice-config.ts` |
| 공급자 | STT: soniox(실시간 WebSocket 에 발화 하나를 흘린다) · elevenlabs(Scribe) · openai(호환 서버 포함). TTS: elevenlabs · typecast · azure · google · openai | `modules/voice/providers/*` |
| 낭독 정리 | `toSpeakable()`(코드·표·URL·식별자 제거, 경로는 마지막 조각) + `splitSpeakable()`(문장 경계 조각, 첫 조각은 짧게) | `modules/voice/speakable.ts` |
| REST (`voice.use`, 기본 admin) | `GET /api/voice/config` · `POST /api/voice/transcribe`(raw 오디오 본문) · `POST /api/voice/speakable` · `POST /api/voice/speech` | `modules/voice/voice.controller.ts` |
| REST (admin) | Voice lab — `POST /api/voice/lab/transcribe?provider=` · `POST /api/voice/lab/speech` · `GET /api/voice/lab/voices?provider=` | 같은 파일 |
| 화면 — 세션 | 컴포저 🎙 = **대화 모드**(아래), 헤더 "Read aloud"(턴이 끝나면 최종 답 낭독). **말로 물은 답은 Read aloud 가 꺼져 있어도 읽는다**(voice in → voice out). 보고 있는(visible) 화면에서만 읽고, 세션 화면을 떠나면 멈춘다 | `components/sessions/*`, `voice/*` |
| 화면 — Admin → Voice | 엔진 설정 + STT 비교(같은 발화를 모든 공급자에, 정답을 적으면 CER) + TTS 블라인드 테스트(문장마다 다시 섞은 A/B/C, 평점 뒤 공개, "Use this voice") | `components/admin/VoicePage.tsx` |

- 한 턴의 "읽을 답" 은 마지막 도구·권한·질문·plan 뒤의 텍스트 덩어리다(`voice/turnAnswer.logic.ts`). 답 뒤에
  정리용 도구로 끝난 턴은 비어 있지 않은 마지막 덩어리를 읽고, 사용자가 멈춘(cancelled) 턴은 읽지 않는다.
- 공급자가 꺼져 있거나 이름이 틀렸거나 키가 없으면 409 + 사유다. 다른 공급자로 넘어가지 않는다. 공급자의
  401/403 도 409(운영자가 고칠 설정), 그 밖의 실패는 502, 시간 초과는 504.
- Soniox 는 발화 하나를 실시간 WebSocket 에 `audio_format: "auto"` 로 흘린다. auto 형식 목록에 webm(Chrome ·
  Android WebView 녹음)은 있지만 **mp4 컨테이너(iOS Safari 녹음)는 없다** — iOS 단계에서 확인하고, 안 되면 그때 변환이나
  비동기 API 를 붙인다. ElevenLabs Scribe · OpenAI 는 mp4/m4a 를 받는다.
- 회귀: `apps/server/test/voice-{speakable,gateway,http}.test.mjs`, `apps/client/test/voice-{turn-answer,lab}.test.mjs`.

## 대화 모드 (2026-10-04)

처음의 "🎙 탭 → 말 → 다시 탭" 은 버튼으로 녹음을 끊어야 전사가 돌았다. 지금은 🎙 를 **한 번 켜 두면** 브라우저가
말의 시작과 끝을 스스로 알아채고, 말을 멈출 때마다(약 1.1초 정적) 그 발화를 글자로 바꿔 곧바로 보낸다.

- 판정: **Silero VAD v6**(`@ricky0123/vad-web`, onnxruntime-web)를 브라우저 안에서 돌린다 — 오디오를 서버로 계속
  흘리지 않고, 끝난 발화 구간(16 kHz WAV)만 `/api/voice/transcribe` 로 보낸다. 모델·런타임(약 16MB)은 AWB 가 직접
  내려준다: 빌드 때 `apps/client/scripts/copy-vad-assets.mjs` 가 `public/vad/` 로 복사(gitignore), dev 서버는
  `vite.config.ts` 의 `serveVadAssetsRaw` 가 원본 그대로 준다(Vite 는 public 의 .mjs 를 모듈로 import 하면 500 을 낸다).
- 실시간 자막: 말하는 동안 1.5초마다 지금까지의 구간을 받아써 보여 준다 — 엔진을 그만큼 더 부르므로 **무료인
  셀프호스팅(`local`) 엔진일 때만** 켠다.
- 답을 읽는 동안에는 듣기를 멈춘다(마이크 트랙을 닫는다) — 스피커 소리를 다시 듣고 자기 답을 프롬프트로 보내지 않게.
  읽기가 끝나면 저절로 다시 듣는다. 탭이 숨으면 멈췄다가 돌아오면 다시 듣고, 화면을 떠나면 마이크를 닫는다.
- 검증: 헤드리스 Chromium 의 가짜 마이크(`--use-file-for-fake-audio-capture`)에 정적 1.5초 + 한국어 5.1초 + 정적을 넣고
  ragnar 엔진으로 받아쓴 결과 — 켠 지 0.8초에 듣기 시작, 자막 4번 갱신, 말이 끝나고 약 2.3초(정적 대기 1.1초 포함) 만에
  프롬프트가 자동 전송됐다.
- 남은 것: 말을 끊고 들어오기(barge-in — 읽는 동안에도 듣기)는 에코 제거가 확실한 환경에서만 의미가 있어 아직 없다.
  읽기를 멈추려면 헤더의 "■ Stop reading".

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

## 셀프호스팅 엔진 (ragnar, 2026-10-04)

유료 API 대신 ragnar(DGX Spark 계열: aarch64 · GB10 · 통합 메모리)에서 오픈소스 엔진을 돌린다. AWB 쪽은
**`local` 어댑터**(`modules/voice/providers/local.ts`) 하나이고, 설정은 `voice.local.base_url` · `voice.local.api_key`
— OpenAI 클라우드 어댑터와 주소·키가 달라 둘을 동시에 설정해 Voice lab 에서 비교할 수 있다.

| | 고른 것 | 근거 |
|---|---|---|
| STT | **Qwen3-ASR-1.7B**(Apache-2.0) · vLLM | 한국어 자유발화 CER 최상위 오픈 모델(OpenKoASR: Kspon-other 14.3 vs Whisper-large-v3 16.6). vLLM 0.16+ 내장 — 공식 프롬프트(문맥 = system, 언어 고정 = assistant 접두)를 `/v1/audio/transcriptions` 의 `prompt`·`language` 로 그대로 만든다. 측정: 5초 발화 0.54초, 15초 1.06초(GPU 여유 시) |
| TTS | **Qwen3-TTS-12Hz-1.7B-CustomVoice**(Apache-2.0) · vLLM-Omni 0.30, 목소리 `sohee` | 상업 사용 가능 후보 중 한국어 기본 목소리가 있는 유일한 것. 공개 한국어 CER 은 후보끼리 1점 안쪽(HF Open TTS: Qwen 4.24 · CosyVoice3 3.88 · VoxCPM2 4.75) — 자연스러움은 Voice lab 블라인드 테스트로 확인한다 |

- 구성: `services/voice-server/` — 모델 서버는 localhost 만(ASR: systemd user 유닛 + venv, TTS: Docker
  `vllm/vllm-omni:v0.30.0`), LAN 에는 **게이트웨이 하나**(`awb_voice_server.py`, :8410)만 연다. 게이트웨이가 Bearer 키를
  본문 파싱 전에 검사하고, 브라우저 녹음(webm/opus · mp4/aac)을 16 kHz WAV 로 풀고(PyAV — 시스템 ffmpeg 불필요),
  TTS 의 WAV 를 MP3 로 바꾸고, 목소리 목록(`voices.json`)을 준다.
- GPU 는 ragnar 의 LLM(메모리 0.48)과 나눠 쓴다 — ASR 0.08, TTS 0.06+0.04 로 작게 잡았다. LLM 이 생성 중일 때는 지연이
  늘어난다(TTS 는 실시간보다 느려질 수 있다 — 첫 조각을 짧게 자르는 `splitSpeakable` 이 그래서 중요하다).
- 함정: NGC vLLM 컨테이너 26.04+ 는 드라이버 580 을 거부한다(upstream 이미지는 CUDA 13.0.2 라 그대로 돈다). Qwen3-TTS 는
  `language` 를 `Korean` 같은 이름으로 받는다(`ko` 는 400). 마지막 음절이 잘리는 이슈(QwenLM/Qwen3-TTS#55)가 있어 게이트웨이가
  입력 끝을 문장부호로 맞춘다.

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
