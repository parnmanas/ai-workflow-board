# Board UX 가이드라인

Board 및 board-scoped 페이지(Resources / Actions / QA / Archive / Settings / Leaderboard 등)의 헤더·네비게이션·레이아웃·스타일 단일 기준 문서.

> **상태**: 가이드라인(설계 기준). 이 문서는 구현이 아니라 *규약*이다. 후속 구현 티켓(#2)과 향후 모든 board 화면이 이 기준을 따른다.
>
> **범위**: board 헤더의 진입(sub-menu) UX, 헤더 액션 컴포넌트, board-scoped 페이지 레이아웃, 디자인 토큰 사용, 신규 화면 체크리스트.
>
> **비범위**: 칸반 컬럼/카드/드래그앤드롭 내부 UX, 워크스페이스 좌측 사이드바, admin(`/admin/*`) 화면. 이들은 별도 규약 대상.

관련 코드 기준점(2026-06-18 시점):

- `apps/client/src/components/Board.tsx:404-413` — `headerActionStyle` (헤더 액션 인라인 스타일)
- `apps/client/src/components/Board.tsx:495-553` — `PageHeader` + 6개 평평한 액션 버튼
- `apps/client/src/components/PageHeader.tsx` — 공용 헤더 컴포넌트(`title` / `description` / `actions`)
- `apps/client/src/tokens.ts` — 디자인 토큰(`colors` / `gradients` / `spacing` / `typography` / `radii` / `shadows`)
- `apps/client/src/components/Board{Qa,Actions,Resources,Archive,Settings}Page.tsx` — board-scoped 페이지 래퍼
- `apps/client/src/components/admin/{QaManager,ActionManager}.tsx` — isomorphic manager 컴포넌트
- `apps/client/src/components/common/index.ts` — 공용 UI primitive(`Button` / `Input` / `Select` / `Modal` / `ConfirmDialog` / `Card` / `Badge`)
- `apps/client/src/App.tsx:156-165` — `/ws/:wsId/boards/:boardId/<section>` 라우트

---

## 0. 현재 상태(문제 정의)

Board 헤더는 `PageHeader`의 `actions` 슬롯에 6개의 평평한 버튼/링크를 직접 나열한다(`Board.tsx:500-552`).

```
┌─ PageHeader ──────────────────────────────────────────────────────────────┐
│  My Board                                  [⏸ Pause Board] [🏆 Benchmark]   │
│  board description                         [📁 Resources] [🔬 QA]           │
│                                            [🗄 Archive] [⚙ Settings]        │
└─────────────────────────────────────────────────────────────────────────────┘
```

문제점:

1. **평면적 나열** — 액션이 6개(+조건부 Benchmark)로 늘면서 우선순위/그룹 구분이 없다. 더 늘어나면 헤더가 깨진다.
2. **상태 액션과 네비게이션 액션의 혼재** — Pause(상태 토글)와 Resources/QA/Settings(페이지 이동)가 같은 줄에 같은 모양으로 섞여 있다.
3. **스타일 중복** — `headerActionStyle`이 `Board.tsx`와 `BenchmarkLeaderboardPage.tsx:181`에 각각 인라인으로 복제돼 있다. 공용 컴포넌트가 없어 hover/active/disabled 동작이 정의돼 있지 않다.
4. **좁은 폭 대응 없음** — `PageHeader`의 actions 영역은 `display:flex; gap:8`만 있고 wrap/overflow 규칙이 없어 모바일/좁은 창에서 넘친다.

이 문서는 위 4가지를 해결하는 단일 패턴을 정의한다.

---

## 1. Board sub-menu 패턴

### 1.1 원칙

board 헤더 액션을 **두 부류**로 명확히 나눈다.

| 부류 | 정의 | 예시 | 배치 |
| --- | --- | --- | --- |
| **상태 액션 (state action)** | 현재 board의 상태를 토글/변경. 페이지 이동 없음. | Pause / Resume | 헤더 우측 최우선(항상 노출) |
| **네비게이션 (section nav)** | board-scoped 하위 섹션으로 이동. | Resources · QA · Archive · Settings · Benchmark | sub-menu 그룹 |

상태 액션은 섹션 nav와 **시각·위치적으로 분리**한다. Pause는 "지금 board가 멈춰 있다"는 강한 상태 신호이므로 overflow 안에 숨기지 않는다.

### 1.2 권장 패턴: Primary + Overflow

섹션 nav는 "**1급(primary) 섹션은 노출 + 나머지는 `⋯` overflow 드롭다운**" 패턴으로 통일한다.

- **1급 섹션(항상 노출)**: `QA`, `Resources`. (티켓 요구: QA를 1급 멤버로 포함.)
- **Overflow(`⋯` 드롭다운)**: `Archive`, `Settings`, 그리고 board가 benchmark 모드일 때만 의미 있는 `Benchmark`(leaderboard).
- **조건부 섹션**(`Benchmark`처럼 `board.benchmark_mode === 'on'`일 때만 존재)은 노출 여부와 무관하게 overflow의 우선순위 하단에 둔다. 조건이 거짓이면 항목 자체가 사라진다.

```
┌─ PageHeader ──────────────────────────────────────────────────────────────┐
│  My Board                          [⏸ Pause]  │  🔬 QA   📁 Resources   ⋯   │
│  board description                  (상태)     │      (1급 nav)        (overflow)
└─────────────────────────────────────────────────────────────────────────────┘
                                                                          │
                                                          ┌───────────────▼──┐
                                                          │ 🏆 Benchmark     │  ← benchmark_mode==='on'일 때만
                                                          │ 🗄 Archive       │
                                                          │ ⚙ Settings       │
                                                          └──────────────────┘
```

1급 vs overflow 분류 기준:

- **1급** = 작업 중 자주 드나드는 섹션(QA·Resources).
- **Overflow** = 가끔 쓰거나(Archive), 한 번 설정하면 잘 안 들어가거나(Settings), 조건부(Benchmark)인 섹션.

> 1급 섹션 개수는 **최대 2~3개**로 제한한다. 늘리고 싶으면 먼저 무엇을 overflow로 내릴지 결정한다. "전부 1급"은 다시 평면 나열로 회귀하는 것이다.

### 1.3 before / after 스케치

**Before** (`Board.tsx` 현재 — 평평한 6버튼):

```
[⏸ Pause Board] [🏆 Benchmark] [📁 Resources] [🔬 QA] [🗄 Archive] [⚙ Settings]
```

**After** (상태 1 + 1급 nav 2 + overflow 3):

```
[⏸ Pause]  │  [🔬 QA] [📁 Resources] [⋯]
                                       └→ 🏆 Benchmark / 🗄 Archive / ⚙ Settings
```

### 1.4 모바일 / 좁은 폭 overflow 규칙

`PageHeader`의 actions 영역은 폭이 줄어들면 **순서대로 overflow로 밀어 넣는다(progressive collapse)**. 임의 줄바꿈(wrap)으로 헤더 높이가 들쭉날쭉해지는 것을 금지한다.

붕괴 우선순위(좁아질수록 위→아래로 숨김):

1. 1급 nav 라벨 → **아이콘만** 남긴다(`🔬 QA` → `🔬`). (단, 접근성을 위해 `aria-label`/`title` 유지.)
2. 1급 nav 항목 자체를 overflow(`⋯`)로 흡수.
3. 상태 액션(Pause)은 **라벨을 줄일 수는 있어도(`⏸ Pause Board` → `⏸`) 절대 overflow로 숨기지 않는다.**

브레이크포인트는 픽셀 하드코딩 대신 컨테이너 폭 기준(가능하면 `ResizeObserver`/CSS container query)으로 판단한다. 구현이 어려우면 최소한 "actions가 타이틀과 겹치기 전에 overflow로 흡수"되도록 한다.

overflow 드롭다운 자체:

- 클릭(또는 키보드 Enter/Space)으로 토글, 바깥 클릭/`Esc`로 닫힘.
- 메뉴는 `position: absolute`로 헤더 아래 우측 정렬, `tokens.shadows.dropdown` 사용.
- 메뉴 항목은 동일한 액션 컴포넌트 규약(§2)을 따르되, 가로 정렬이 아닌 세로 리스트 형태.

---

## 2. 헤더 액션 컴포넌트 규약

### 2.1 공용 컴포넌트화

현재 `headerActionStyle`은 `Board.tsx`와 `BenchmarkLeaderboardPage.tsx`에 인라인으로 복제돼 있다. 이를 단일 공용 컴포넌트 **`HeaderAction`**(가칭, `apps/client/src/components/common/` 또는 `PageHeader`와 같은 위치)으로 추출한다.

`HeaderAction`이 흡수해야 할 책임:

- **렌더 타깃 추상화** — `to`(라우터 `Link`) 또는 `onClick`(button) 중 하나를 받아 적절한 엘리먼트로 렌더. 둘 다 동일한 시각 스타일.
- **variant** — `default`(중립 nav) / `state-active`(예: paused 강조) / `primary`(필요 시). 색은 토큰에서만.
- **icon + label** — emoji 아이콘 + 라벨. 좁은 폭에서 label을 숨기고 icon만 남기는 책임도 여기서.
- **disabled** — `disabled` 시 `cursor: not-allowed` + `opacity` 낮춤 + 포인터 이벤트/링크 차단.

기존 `headerActionStyle` 값(추출 기준선):

```ts
{
  padding: '6px 14px',
  borderRadius: tokens.radii.lg,          // 8 — 매직넘버 8 → 토큰으로
  background: tokens.colors.surfaceCard,
  border: `1px solid ${tokens.colors.border}`,
  fontSize: tokens.typography.fontSizeMd, // 13
  color: tokens.colors.textSecondary,
  textDecoration: 'none',
  fontWeight: 500,
}
```

### 2.2 상태(state) 스타일

| 상태 | 스타일 |
| --- | --- |
| **default** | 위 기준선. `color: textSecondary`, `border: 1px solid border`. |
| **hover** | `background: surfaceHover`, `color: textPrimary`. transition `0.15s`. |
| **active(눌림)** | 살짝 어둡게 / 눌림 피드백. 라우트가 현재 섹션과 일치하면 `aria-current` + accent 보더로 "현재 위치" 표시 권장. |
| **disabled** | `opacity: 0.5`, `cursor: not-allowed`, 포인터 이벤트 없음. |
| **state-active (강조)** | board paused처럼 "현재 활성 상태"를 강조. 현재 Pause 구현 기준: `background: tokens.colors.warning`, `color: '#fff'`, `border: none`, `fontWeight: 600`. → 이 강조 패턴을 `variant="state-active"`로 일반화하되 색은 의미에 맞는 토큰(warning/danger/success)을 받도록. |

> `#fff`는 paused 강조 같은 "채워진 강조 버튼 위 텍스트"에 한해 허용한다. 가능하면 `tokens.colors.textPrimary`를 우선 검토하고, 명시적 흰색이 필요한 곳은 주석으로 사유를 남긴다.

### 2.3 아이콘(emoji) 규칙

- **일관된 한 벌 유지** — 섹션↔emoji 매핑은 1:1 고정. 현재 매핑을 기준으로 한다:
  - ⏸ / ▶ Pause·Resume · 🏆 Benchmark · 📁 Resources · 🔬 QA · 🗄 Archive · ⚙ Settings · ← Back
- 새 섹션 추가 시 **기존에 안 쓰인 emoji 하나**를 골라 이 매핑 표(이 문서 §2.3)에 등록하고 재사용한다. 같은 의미에 다른 emoji를 쓰지 않는다.
- emoji는 **장식이 아니라 식별자**다. 따라서 icon-only로 축약될 때를 대비해 항상 텍스트 라벨/`aria-label`을 동반한다. 스크린리더가 emoji만 읽게 두지 않는다.
- emoji 외 별도 아이콘 라이브러리(svg 등)는 도입하지 않는다(현재 의존성 추가 금지, 토큰/기존 패턴 존중).

---

## 3. 페이지 레이아웃 규약

### 3.1 board-scoped 페이지의 표준 골격

모든 board-scoped 페이지는 다음 골격을 따른다(현 `BoardQaPage.tsx` 패턴이 기준):

```tsx
export default function BoardXxxPage() {
  const { wsId, boardId } = useParams<{ wsId: string; boardId: string }>();
  const { board } = useBoard(boardId ?? '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Xxx" description={board?.name} />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '24px' }}>
        <XxxManager workspaceId={wsId} boardId={boardId} />
      </div>
    </div>
  );
}
```

규칙:

- **full-height flex column** — 루트는 `height: 100%`, `display: flex`, `flexDirection: column`, `minHeight: 0`. (`minHeight: 0`이 없으면 자식 스크롤 컨테이너가 부모를 넘어 늘어난다.)
- **헤더는 `PageHeader` 단일 사용** — 직접 `<header>`를 만들지 않는다. `title`/`description`/`actions`만 채운다. `description`에는 board 컨텍스트(`board?.name`)를 넣어 어느 board의 섹션인지 표시.
- **본문은 단일 스크롤 컨테이너** — `flex: 1; overflow: auto; minHeight: 0; padding: 24px`(= `tokens.spacing.lg`). 패딩/스크롤을 본문 컨테이너가 소유하고, 내부 manager는 패딩을 다시 주지 않는다.
- **뒤로 가기** — 하위 detail 화면(예: leaderboard)은 헤더 actions에 `← Back to Board`(`/ws/:wsId/boards/:boardId`) `HeaderAction`을 둔다.

### 3.2 라우트 네이밍

board-scoped 섹션은 예외 없이 다음 형태를 따른다(`App.tsx:156-165` 기준):

```
/ws/:wsId/boards/:boardId/<section>
```

- `<section>`은 단수 명사 kebab(현재: `resources`, `actions`, `qa`, `settings`, `archive`, `leaderboard`). 신규 섹션도 동일 규칙.
- board 루트는 `/ws/:wsId/boards/:boardId`(칸반 뷰).
- 라우트 추가 시 `Board.tsx`의 sub-menu(§1)에 해당 섹션 진입점을 함께 등록한다. 라우트만 추가하고 진입 UI를 안 만들면 "숨은 페이지"가 된다.

### 3.3 manager 페이지 공통 구조 (List → detail → run/edit/delete)

`QaManager` / `ActionManager`는 같은 구조를 공유하는 **isomorphic manager** 패턴이다. 신규 manager는 이 구조를 따른다.

- **컴포넌트 계약** — `({ workspaceId?: string; boardId?: string | null })` props를 받아, board-scoped 페이지와 workspace-scoped 페이지 양쪽에서 재사용된다(동일 컴포넌트, scope만 props로).
- **상태 머신** — 단일 manager가 다음 상태를 가진다(`ActionManager` 기준):
  - `list` — 항목 리스트(로딩/빈 상태 포함)
  - `selected` — 선택된 항목 detail
  - `showForm` / `editAction` — 생성/편집 폼(`Modal`)
  - `deleteTarget` — 삭제 확인(`ConfirmDialog`)
  - `running` — 실행 중 표시
- **공용 primitive 사용** — 폼/버튼/뱃지/모달은 `components/common`의 `Button` / `Input` / `Select` / `Modal` / `ConfirmDialog` / `Card` / `Badge`만 쓴다. 새로 만들지 않는다.
- **빈 상태(empty state)** 와 **로딩 상태**를 항상 명시적으로 렌더(빈 화면 금지).

---

## 4. 디자인 토큰 사용 규칙

`apps/client/src/tokens.ts`가 단일 소스. **임의의 hex 색·px 간격·radius·shadow를 인라인으로 쓰지 않는다.**

| 용도 | 사용 토큰 |
| --- | --- |
| 배경/표면 | `tokens.colors.surface` / `surfaceCard` / `surfaceHover` / `surfaceSubtle`, `tokens.gradients.surfaceCard` |
| 보더 | `tokens.colors.border` / `borderStrong` |
| 텍스트 | `tokens.colors.textPrimary` / `textStrong` / `textSecondary` / `textMuted` |
| 강조/accent | `tokens.colors.accent` / `accentViolet` / …, `tokens.gradients.accent` |
| 상태색 | `success` / `danger` / `warning` / `info`(및 `*Bg` 변형) |
| 간격 | `tokens.spacing.xs|sm|md|lg|xl`(4/8/16/24/32) |
| 폰트 | `tokens.typography.fontSize*`, `fontWeight*`, `lineHeight*` |
| 모서리 | `tokens.radii.xs|sm|md|lg|xl|full` |
| 그림자 | `tokens.shadows.card|dropdown|panel|modal|overlay` |

규칙:

- **매직넘버 금지** — `borderRadius: 8` → `tokens.radii.lg`, `padding: 24` → `tokens.spacing.lg`. 기존 인라인 매직넘버(`headerActionStyle`의 `8`, `'6px 14px'` 등)는 컴포넌트화하며 토큰으로 치환한다.
- **opacity로 만든 임시 색**(`${tokens.colors.accent}30` 같은 알파 접미) 은 drag-over 하이라이트 등 기존 사용처에 한해 허용하되, 새로 추가할 때는 가급적 토큰 조합으로 표현하고 사유를 주석으로 남긴다.
- **하드코딩 흰/검정** — `#fff`/`#000`은 §2.2의 채워진 강조 버튼 위 텍스트 같은 명시적 예외만. 그 외는 텍스트 토큰 사용.
- 토큰에 없는 값이 반복적으로 필요하면 **인라인으로 박지 말고 `tokens.ts`에 추가**한 뒤 쓴다(토큰을 늘리는 PR은 작게).

---

## 5. 체크리스트 — 새 board 화면/메뉴 추가 시

새 board-scoped 섹션이나 헤더 액션을 추가할 때 아래를 모두 만족하는지 확인한다.

**라우트 & 진입점**
- [ ] 라우트가 `/ws/:wsId/boards/:boardId/<section>`(단수 kebab) 형태인가? (`App.tsx`에 등록)
- [ ] `Board.tsx`의 sub-menu(§1)에 진입점을 등록했는가? (라우트만 있고 진입 UI 없는 "숨은 페이지" 금지)
- [ ] 1급(노출) vs overflow(`⋯`) 분류를 정했는가? 1급은 최대 2~3개 규칙을 지켰는가?
- [ ] 조건부 섹션이면 노출 조건(예: `benchmark_mode === 'on'`)을 명시했는가?

**헤더 액션**
- [ ] 인라인 스타일이 아니라 공용 `HeaderAction`(또는 동등 컴포넌트)을 썼는가?
- [ ] 섹션 emoji를 §2.3 매핑 표에 1:1로 등록/재사용했는가? (중복·임의 emoji 금지)
- [ ] hover/active/disabled, 그리고 상태 액션이면 `state-active` 강조를 정의했는가?
- [ ] icon-only 축약 시에도 `aria-label`/`title`로 접근성을 유지하는가?
- [ ] 상태 액션은 overflow로 숨기지 않도록 했는가?

**레이아웃**
- [ ] full-height flex column(`height:100%`, `minHeight:0`) 골격을 따랐는가?
- [ ] 헤더는 `PageHeader`(title/description/actions)만 사용했는가? (직접 `<header>` 금지)
- [ ] 본문은 단일 스크롤 컨테이너(`flex:1; overflow:auto; minHeight:0; padding: lg`)인가?
- [ ] manager면 `({ workspaceId, boardId })` 계약 + List→detail→form(Modal)→delete(ConfirmDialog) 구조 + `common` primitive를 따랐는가?
- [ ] 빈 상태/로딩 상태를 명시적으로 렌더하는가?
- [ ] detail/하위 화면이면 `← Back` 진입점이 있는가?

**토큰**
- [ ] 색·간격·radius·shadow·폰트를 모두 `tokens.*`에서 가져왔는가? (매직넘버/임의 hex 0건)
- [ ] 토큰에 없는 반복 값은 인라인 대신 `tokens.ts`에 추가했는가?

**좁은 폭**
- [ ] 좁은 폭에서 progressive collapse(라벨→아이콘→overflow 흡수) 규칙을 따르는가? (임의 wrap으로 헤더가 깨지지 않는가)

---

## 부록 A — 구현 티켓(#2)을 위한 우선순위 제안

이 문서는 규약만 정의한다. 후속 구현은 다음 순서를 권장한다(이 문서가 prerequisite).

1. `HeaderAction` 공용 컴포넌트 추출(§2) + `headerActionStyle` 중복 2곳(`Board.tsx`, `BenchmarkLeaderboardPage.tsx`) 치환. — 가장 안전한 첫 단계, 시각적 변화 최소.
2. `Board.tsx` sub-menu 재구성(§1): 상태(Pause) 분리 + 1급(QA/Resources) + `⋯` overflow(Benchmark/Archive/Settings).
3. progressive collapse(§1.4) 적용.
4. 잔여 board-scoped 페이지의 레이아웃·토큰 정합성 점검(§3·§4)을 §5 체크리스트로 일괄 검수.
