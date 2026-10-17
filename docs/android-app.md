# Android 앱 (`apps/android`)

AWB Android 앱은 **서버가 서빙하는 AWB 웹 화면 전체를 앱 안의 WebView 로 띄우고**, 웹이 할 수 없는 것만 네이티브로
한다. 웹 빌드를 앱에 묶지 않는다 — 화면은 서버 배포를 그대로 따라가고, 앱 업데이트는 네이티브가 바뀔 때만 필요하다.

| 네이티브가 맡는 것 | 왜 웹으로 안 되나 |
|---|---|
| 상시 음성(백그라운드 듣기 · 대화 · 낭독) | 브라우저는 화면이 꺼지거나 다른 앱이 앞에 오면 마이크를 끊는다 |
| 끊기지 않는 로그인(단말 자격) | 사용자 세션은 서버 메모리에만 있어 24시간 · 배포 재시작마다 끊긴다 |
| 구글 로그인 왕복 | Google 은 WebView 안의 로그인을 막는다(disallowed_useragent) |
| 다른 사이트 링크 · 내려받기 · 파일 고르기 · 마이크 권한 | WebView 기본값으로는 아무 일도 일어나지 않는다 |

예전 Capacitor 껍데기(`apps/client/android`)는 웹 빌드를 묶어 `https://localhost` 에서 돌았다 — 서버와 오리진이 달라
CORS 설정이 필요했고, 구글 로그인은 페이지째 이동이라 시스템 브라우저로 빠져나가 앱으로 돌아오지 않았다. 그래서 버렸다.

## 구성

```
MainActivity      WebView(서버 오리진) + 서버 주소 / 오프라인 화면 + 딥링크(awb://oauth · awb://sessions/…)
WebBridge         window.AwbAndroid — 서버 오리진의 최상위 문서에만 주입(androidx.webkit WebMessageListener)
Auth              세션 토큰의 단일 출처. 단말 자격으로 세션을 다시 받는다
GoogleLogin       PKCE + Custom Tab
voice/VoiceService  상시 음성 포그라운드 서비스(microphone|mediaPlayback)
voice/Vad · VoiceApi · EventStream · Speaker · VoiceRules
```

웹 쪽 짝: `apps/client/src/native/androidBridge.ts`(요청/응답 · 이벤트), `native/AndroidAppBridge.tsx`(이동 · 스위치 맞추기 ·
숨으면 대화 내려놓기), `components/AndroidVoiceCard.tsx`(설정 → Device).

### WebView 가 대신 해 주지 않는 것 — 화면 쪽에서 맞춘다

- **페이지 확대가 꺼져 있다**(WebView 기본값: built-in zoom off). 두 손가락 확대가 필요한 화면은 웹이 직접 계산한다 —
  첨부 이미지/영상 라이트박스(`components/common/ZoomStage.tsx`, 계산은 `zoomPan.logic.ts`)가 핀치 · 드래그 · 더블탭 ·
  스와이프(넘기기/닫기)를 다룬다. 새 확대 화면도 이것을 쓴다 — 웹 · 앱 · 데스크톱이 같은 제스처를 탄다.
- **뒤로 버튼은 `WebView.goBack()`** 이다. history 항목이 없는 오버레이는 뒤로를 누르면 화면째 사라진다 —
  라이트박스는 `components/common/useCloseOnBack.ts` 로 열려 있는 동안 같은 주소의 항목 하나를 얹어 뒤로가 그것을 닫게 한다.
  네이티브 변경 없이 웹 배포만으로 따라온다.

## 로그인

1. 화면(WebView)에서 로그인한다 — 이메일/비밀번호는 웹 폼 그대로, 구글은 `oauth.google` 브릿지 → Custom Tab →
   `GET /api/auth/oauth/google/start?app=android&code_challenge=<S256>` → Google → callback 이
   `awb://oauth?code=…` 로 앱을 연다 → 앱이 `POST /api/auth/oauth/app/exchange {code, code_verifier}` 로 세션을 받는다.
   코드는 PKCE 로 묶여 있어 같은 스킴을 가로챈 다른 앱은 쓸 수 없다. 세션 토큰은 리다이렉트에 실리지 않는다.
2. 웹이 `session.loggedIn` 을 보내면 앱이 `POST /api/auth/devices` 로 **단말 자격**(`awbd_…`, 서버는 sha256 만 저장 —
   `UserDevice`)을 받아 둔다.
3. 세션이 끊기면(배포 재시작 · 24시간) — 웹의 401 은 `session.refresh`, 앱 부팅은 `session.get`, 서비스는 스스로 —
   `POST /api/auth/devices/session {device_token}` 으로 새 세션을 받는다. 다시 로그인하지 않는다.
4. 로그아웃은 `POST /api/auth/devices/revoke` 로 단말 자격을 회수한다. 잃어버린 단말은 `GET/DELETE /api/auth/devices[/:id]`.

구글 로그인의 `state` 는 무작위 · 한 번만 · 10분이다(웹 흐름도 같다 — 예전의 고정 `'awb'` 는 로그인 CSRF 를 막지 못했다).

## 상시 음성

같은 단말에서 둘이 같이 들으면 같은 부름에 두 번 깨어나고 같은 답을 두 번 읽는다. 그래서 **앱 화면이 보이는가**
(`AppState`) 하나로 나눈다.

| | 앱 화면이 보일 때 | 안 보일 때(다른 앱 · 화면 꺼짐 · 잠금) |
|---|---|---|
| 듣기 · 깨우기 · 대화 | 웹 화면(WakeListener · 대화 모드) | `VoiceService` |
| 알림 낭독 · 알림음 | 웹 화면(VoiceAnnouncer) | `VoiceService` |
| 마이크 | WebView | 서비스(`VOICE_RECOGNITION`) |

웹은 앱 안에서 숨으면 손을 뗀다(`hiddenInAndroidApp()`), 서비스는 앱이 보이면 마이크를 놓는다.

서비스는 웹과 **같은 엔드포인트 · 같은 규칙**을 쓴다(새 경로 없음):

- 잠듦: 발화 → `POST /api/voice/transcribe?purpose=wake`(자체 호스팅 엔진) → `POST /api/voice/operators/match`.
  알림 뒤 15초는 이름 없이, 10분 안의 "보고해" 는 그 operator 로.
- 깨어남: 신호음 → 호출어를 포함한 발화 전체 · 이어지는 말이 `POST /api/agent-sessions/hosts/…/prompt` 로(첫 요청에만
  `WAKE_PROMPT_NOTE`). 이름만 불러도 operator 가 직접 답한다. 바쁘면 줄 세운다. 답은 `/api/events/stream` 의
  `agent_session_event` 로 받아 문장이 완성될 때부터 `POST /api/voice/speakable {summary:true,partial:true}` 로
  다듬는다. Qwen 은 `POST /api/voice/speech/stream` 의 PCM 을 AudioTrack 으로 즉시 읽으며, 다른 공급자는
  기존 `/api/voice/speech` 를 쓴다. 세그먼트·턴 완료 시 남은 문장을 읽고 이미 말한 부분은 반복하지 않는다.
  `[[sleep]]` 이나 60초 조용하면 잠든다. 깨어 있는 동안 `PUT /api/voice/presence` 로 "이 단말이 맡았다" 를 알린다.
- 알림: `voice_announcement` 의 `operator_reply` 는 낭독(`/api/voice/announcements/:id/audio`), 나머지는 알림음 + 알림.
- 스위치: 사이드바 👂 음성 지원 스위치와 앱의 상시 음성은 **같은 스위치**다(`wakeStore.setEnabled` ↔ `voice.setEnabled`).
  서버에는 `PUT /api/voice/support {device_id: "android-<단말 id>"}` 로 알린다.

`VoiceRules.java` 는 `apps/client/src/voice/wake.logic.ts` 의 사본이다 — 바꾸면 둘 다 바꿀 것
(`apps/client/test/android-voice-rules.test.mjs` 가 글자 그대로 비교한다). 브릿지 요청 이름은
`apps/client/test/android-bridge.test.mjs` 가 `WebBridge.java` 와 맞춘다.

### Android 제약

- 마이크 포그라운드 서비스는 **앱이 보이는 동안에만 시작할 수 있다**(while-in-use). 그래서 `MainActivity.onStart` 가
  서비스를 (다시) 띄운다. 재부팅 뒤에는 "탭하면 다시 듣습니다" 알림만 띄운다(`BootReceiver`, Android 15+ 는
  BOOT_COMPLETED 에서 마이크 서비스를 막는다). OS 가 화면 밖에서 서비스를 되살리면 마이크가 0 만 주는데, 서비스가
  이를 알아채 알림에 "앱을 한 번 열어 주세요" 를 띄운다.
- 절전 예외가 없으면 몇 시간 뒤 서비스가 멈춘다 — 상시 음성을 처음 켤 때 한 번 묻고, 설정 카드에서 다시 열 수 있다.
- http 서버는 쓸 수 있지만, 서버 CSP 의 `upgrade-insecure-requests` 와 WebView 의 보안 컨텍스트 규칙 때문에 화면과
  음성은 **https 서버**에서만 제대로 돈다.

## 빌드 · 배포

```
cd apps/android
JAVA_HOME=<jdk 17+> ./gradlew assembleRelease      # local.properties 의 awb.keystore.* 로 서명
JAVA_HOME=<jdk 17+> ./gradlew testDebugUnitTest    # VoiceRules · Vad 단위 테스트
```

- `applicationId com.parnmanas.awb` 와 릴리즈 키가 Capacitor 껍데기와 같아 덮어 설치로 올라간다. `versionCode` 는 손으로
  올린다(10 = 이 재작성, 11 = Qwen 스트리밍).
- 배포는 GitHub release 의 `awb-android.apk` 자산이다 — 설정 · 자료실의 "Android 앱 받기" 가 `releases/latest` 를 본다
  (`apps/client/src/githubRelease.ts`).
- **서버를 먼저 배포한다.** 앱의 로그인 유지 · 구글 로그인은 서버의 `/api/auth/devices*` · `oauth/app/exchange` 가 있어야 한다.

## 에뮬레이터 E2E

에뮬레이터에는 마이크 소리를 넣을 길이 없어서, 디버그 빌드에만 발화 주입 훅이 있다:
`adb shell am broadcast -a com.parnmanas.awb.DEBUG_UTTERANCE -p com.parnmanas.awb [--es file x.wav]`.
서버는 운영과 따로 띄운다(scratch SQLite, 다른 포트). 앱은 `adb reverse tcp:<port> tcp:<port>` 로 `http://localhost:<port>`
에 붙인다 — `10.0.2.2` 는 보안 컨텍스트가 아니라 CSP 가 자원을 https 로 올려 화면이 비어 버린다. 로그는 `adb logcat -s AWB-Voice`.
