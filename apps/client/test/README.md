# 클라이언트 테스트 하네스

AWB 레포에는 jest/vitest/jsdom 이 없다(루트 `CLAUDE.md` 참조). 클라이언트 로직
회귀는 Node 내장 test runner(`node:test`)로 검증한다 — 서버(`apps/server/test`)와
동일한 방식이다. 브라우저·별도 러너 불필요.

## 실행

```bash
# 레포 루트에서 (권장 — 로컬/CI 공통)
npm test -w client

# 또는 직접
node --import tsx --test apps/client/test/chat-participants.test.mjs
```

- `--import tsx` 는 테스트가 import 하는 `.ts`/`.tsx` 소스를 온더플라이로
  트랜스파일한다(`tsx` 는 `apps/client` devDependency). 순수 로직만 담긴
  `.ts` 모듈은 `import type` 만 갖고 있어 런타임에 React/DOM 을 끌어오지 않는다.
- CI: 루트 `npm ci` 후 `npm test -w client`. 빌드 게이트(`tsc && vite build`)와는
  별개로, 로직 회귀는 이 테스트가 지킨다.

## 테스트 목록

| 파일 | 대상 | 실제 구동 코드 |
|------|------|----------------|
| `on-done-reorder-dirty.test.mjs` | Run-on-Done 재정렬 dirty 판정 (티켓 59afc55a) | 로직 미러 (`TicketPanel.tsx` 와 동기화 유지) |
| `chat-participants.test.mjs` | 채팅 참여자 경합/반영/후보 제외 (티켓 6dfb5921) | **실제** `chat/utils/participantFlow.ts` (미러 아님) |
| `composer-send.test.mjs` | 컴포저 전송 후 focus 복귀 게이팅 + 전송 중 paste 첨부 경합 (티켓 e0567bb3) | **실제** `chat/utils/composerSend.ts` (미러 아님) |

## `chat-participants` 의 mock / 시드 모델

브라우저·서버·네트워크 없이 **의존성 주입**으로 참여자 흐름을 결정적으로 구동한다.
검증 대상(`participantFlow.ts`)은 ChatPage/ParticipantPicker 가 실제로 import 하는
바로 그 모듈이다 — 순수 헬퍼뿐 아니라 **컴포넌트의 연결부(SSE 디스패치·후보 로드)까지**
이 모듈로 추출돼 있어, **추출된 `dispatchChatRoomUpdate`/`loadAddPeopleCandidates` 내부의
분기·배선**을 지우거나 오배선하면 테스트가 실패한다. (컴포넌트에 남는 `useBoardStreamEvent`
등록·DI 리터럴은 이 테스트가 잡지 못한다 — 아래 "커버 경계" 참조.)

- `dispatchChatRoomUpdate` = ChatPage 의 `chat_room_update` 핸들러 본문(봉투 unwrap +
  `update_type` 분기 → `reflectParticipantChange`). ChatPage 는 ref/세터/스코프만 주입한다.
- `loadAddPeopleCandidates` = ParticipantPicker 의 open effect 로드 본문(`getUsers`/
  `getAgents` fetch → 후보 빌드 → `setParticipants`). Picker 는 `api`·세터만 주입한다.

**커버 경계(정직한 잔여물):** 컴포넌트에 남는 미검증 코드는 `useBoardStreamEvent(...)`
등록과 DI 리터럴(어떤 ref/세터를 주입하는지)뿐이다 — 이 React glue 는 jsdom 풀마운트가
있어야 실행되며, 이 레포는 jsdom 이 없다(루트 `CLAUDE.md`). 위 두 함수 추출로 그 미검증
표면을 "한 줄 위임 + 리터럴"까지 최소화했다. 실제 dispatch/branch/load/exclusion 로직은
전부 이 테스트가 구동한다.

- **API mock**: `getChatRoom` / `listChatRooms` / `getUsers` / `getAgents` 를 테스트가
  주입하는 함수로 대체. 네트워크 호출 없음.
- **응답 순서 통제**: `deferred()` 로 방별 응답 promise 를 만들어, 테스트가 완료
  시점을 임의 순서로 지정 → 방 전환 경합(응답 역전)을 결정적으로 재현.
- **활성 방/observer 상태**: ChatPage 의 ref 를 흉내낸 가변 변수 getter 로 주입
  (`getActiveRoomId: () => activeRoomId`) — "응답 시점"의 값을 읽는 P2 가드를 그대로 실행.
- **rooms 상태 세터**: `makeRoomsState()` 가 React useState 세터(값 또는 updater 함수)를
  흉내내, `dispatchChatRoomUpdate` 의 renamed/read updater 경로까지 구동한다.
- **최소 시드**: `user()`/`agent()`/`roomDetail()`/`roomListItem()` 인메모리 팩토리
  (테스트 파일 상단). 실제 DB/서버 부팅 불필요.

### 시나리오 (완료 조건 매핑)

1. **방 전환 응답 역전 경합 (P2)** — 방 A 재조회 진행 중 방 B 전환 → 응답을 B→A
   역순 완료 → B 로스터 유지(늦은 A 응답 폐기). 제어군(전환 없음)에서는 응답이
   정상 반영됨도 함께 단언해 가드가 stale 만 버림을 증명.
2. **participant_added / participant_left 반영 (SSE 연결부 포함)** — `dispatchChatRoomUpdate`
   에 실제 이벤트 페이로드(서버 봉투/flat 두 shape)를 넣어: ①활성 방 `participant_added`
   → 로스터 + 방 목록 동시 재조회, ②**활성 방 `participant_left` → 로스터도 재조회**(직접
   단언), ③비활성 방 이벤트 → 방 목록만 갱신. `renamed`/`read`/미지 타입은 participant
   재조회를 트리거하지 않음(분기 게이팅) + `read`(본인)은 unread 0 동기화까지 단언.
3. **Add People 후보 제외** — `buildAddPeopleCandidates` 로 기존 참여자·본인·Agent
   Manager(type='manager') 제외 + `loadAddPeopleCandidates` 로 fetch→빌드→set 배선과
   조회 실패 시 `[]` 폴백까지 구동.

> 참고: 원본 티켓 141b7414(참여자 표시·추가)의 P2 경합은 멀티유저 브라우저 E2E
> 하네스 부재로 수동 시뮬레이션으로만 회귀 확인됐다. 이 테스트가 그 자동 검증
> 공백을 메운다.
