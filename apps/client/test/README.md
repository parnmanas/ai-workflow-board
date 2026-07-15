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

## `chat-participants` 의 mock / 시드 모델

브라우저·서버·네트워크 없이 **의존성 주입**으로 참여자 흐름을 결정적으로 구동한다.
검증 대상(`participantFlow.ts`)은 ChatPage/ParticipantPicker 가 실제로 import 하는
바로 그 모듈이므로, 컴포넌트에서 가드/제외 로직을 지우면 이 테스트가 실패한다
(미러가 아니라 실코드 커버리지).

- **API mock**: `getChatRoom` / `listChatRooms` 를 테스트가 주입하는 함수로 대체.
  네트워크 호출 없음.
- **응답 순서 통제**: `deferred()` 로 방별 응답 promise 를 만들어, 테스트가 완료
  시점을 임의 순서로 지정 → 방 전환 경합(응답 역전)을 결정적으로 재현.
- **활성 방/observer 상태**: ChatPage 의 ref 를 흉내낸 가변 변수 getter 로 주입
  (`getActiveRoomId: () => activeRoomId`) — "응답 시점"의 값을 읽는 P2 가드를 그대로 실행.
- **최소 시드**: `user()`/`agent()`/`roomDetail()`/`roomListItem()` 인메모리 팩토리
  (테스트 파일 상단). 실제 DB/서버 부팅 불필요.

### 시나리오 (완료 조건 매핑)

1. **방 전환 응답 역전 경합 (P2)** — 방 A 재조회 진행 중 방 B 전환 → 응답을 B→A
   역순 완료 → B 로스터 유지(늦은 A 응답 폐기). 제어군(전환 없음)에서는 응답이
   정상 반영됨도 함께 단언해 가드가 stale 만 버림을 증명.
2. **participant_added / participant_left 반영** — 활성 방 로스터 + 방 목록 동시
   재조회. 비활성 방 이벤트는 방 목록만 갱신하고 로스터는 건드리지 않음.
3. **Add People 후보 제외** — 기존 참여자·본인·Agent Manager(type='manager')를
   후보에서 제외.

> 참고: 원본 티켓 141b7414(참여자 표시·추가)의 P2 경합은 멀티유저 브라우저 E2E
> 하네스 부재로 수동 시뮬레이션으로만 회귀 확인됐다. 이 테스트가 그 자동 검증
> 공백을 메운다.
