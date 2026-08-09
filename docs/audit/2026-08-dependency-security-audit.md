# 의존성 패키지 보안 감사 (2026-08-05, 재검증 2026-08-06)

`ai-workflow-board` 모노레포(`apps/server`, `apps/client`, `apps/agent-manager`)가
사용하는 npm 패키지와 그 버전에 대한 취약점 전수 감사 기록이다.

> 최신 재검증 결과는 문서 끝의 **"재검증 로그"** 절을 볼 것.

- 기준 커밋: `main` @ `995b7f26`
- 도구: `npm audit` (npm 11.11.0 / Node 24.14.1), GitHub Advisory DB
- 검사 범위: `main` 브랜치 + 배포 브랜치 `production.private`
  (`production.private`의 lockfile은 `main`과 동일 — 이번에는 drift 없음)

## 결과 요약

| 구분 | 감사 전 | 조치 후 |
| --- | --- | --- |
| 전체 (dev 포함) | 8건 (high 7, moderate 1) | 2건 (high 2 — 동일 advisory 1건) |
| 런타임 의존성만 (`--omit=dev`) | 6건 (high 5, moderate 1) | 2건 (동일 advisory 1건) |

조치 후 남은 2건은 `react-router` / `react-router-dom` 한 쌍이며,
아래 "미조치 항목"에서 설명하듯 **본 애플리케이션에는 해당되지 않는다**.

## 조치한 취약점

모두 `package-lock.json` 재해결(semver 범위 내 상향)으로 해결했다. 직접
의존성의 선언 범위(`apps/*/package.json`)는 변경하지 않았다.

| 패키지 | 이전 → 이후 | 심각도 | Advisory |
| --- | --- | --- | --- |
| `ip-address` | 10.2.0 → 10.4.0 | high | GHSA-mwp4-54f8-5fhr, GHSA-4xrf-jv44-h6hh, GHSA-22jq-vg5j-6vgg (SSRF / 신뢰 경계 우회) |
| `brace-expansion` | 1.1.16 → 1.1.18, 2.1.2 → 2.1.4, 5.0.7 → 5.0.9 | high | CVE-2026-14257 계열 (unbounded expansion DoS) |
| `fast-uri` | 3.1.4 → 3.1.5 | high | backslash authority introducer host confusion |
| `postcss` | 8.5.16 → 8.5.25 | high | GHSA-r28c-9q8g-f849, GHSA-fxqj-rqcc-2cmp (sourceMappingURL path traversal) |
| `undici` | 7.28.0 → 7.29.0 | high | GHSA-8xcm-r25x-g524 외 4건 (response desync / CRLF injection / cache 정보 노출) |
| `hono` | 4.12.29 → 4.13.0 | moderate | CORS 미들웨어 ReDoS |
| `@hono/node-server` | 2.0.11 → 2.1.0 | (override 유지) | GHSA-frvp-7c67-39w9 회귀 방지 |

### `js-yaml` override 갱신 (선제 조치)

`@nestjs/swagger`가 11.4.5 → 11.4.6으로 올라가면서 `js-yaml`을 **정확히
5.2.1**로 고정하는데, 5.2.1은 GHSA-pm4m-ph32-ghv5 (flow collection 파싱
지수 시간 → DoS)에 취약하다. 기존 root override `"@nestjs/swagger": {"js-yaml":
"^4.2.0"}`는 4.x 계열로 강제하던 것인데, swagger가 의도한 메이저(5.x)에서
벗어나 있어 유지보수 부담이 컸다.

→ override를 `"^5.2.3"`(패치된 최신 5.x)로 변경했다. `cosmiconfig`가 쓰는
`js-yaml`은 override 범위 밖이라 4.3.1로 그대로 남는다(취약 범위 아님).

이것이 이번 감사에서 `package.json`에 가한 **유일한** 변경이다.

## 미조치 항목 (해당 없음 — 의도적 유지)

### `react-router` / `react-router-dom` — GHSA-qwww-vcr4-c8h2 (high)

> **[2026-08-08 해소됨 — 아래 절은 이력으로만 읽을 것]**
> GitHub 이 2026-08-07T18:16Z advisory 를 개정해 7.x 취약 범위를
> `< 8.3.0` → `< 7.18.2` 로 좁히고 7.x first patched version 을 **7.18.2** 로
> 지정했다. 저장소는 이미 7.18.2 였으므로 **버전 변경 없이 취약 상태에서
> 벗어났고**, `npm audit` 은 0건이 됐다. `react-router-dom` 은 advisory 대상에서
> 제외됐다. 따라서 아래의 "해당 없음 승인"과 "재검토 트리거"는 더 이상
> 유효한 운영 지침이 아니다 — 현재 방어선은 **7.18.2 버전 바닥**이며
> `apps/client/test/react-router-rsc-guard.test.mjs` 가 이를 강제한다.
> 상세는 맨 아래 2026-08-08 재검증 로그 참조.

- 내용: "RSC Mode CSRF Bypass Allows Action Execution Before 400 Response"
- 취약 범위: `>= 7.12.0, < 8.3.0` / 패치 버전: **8.3.0 뿐 (7.x 패치 릴리스 없음)**
- 현재 버전: `react-router-dom@7.18.2` → `react-router@7.18.2`

**해당 없음으로 판단한 근거:**

1. Advisory 본문이 "This only affects your application if you are using the
   unstable RSC APIs"라고 명시한다. 취약 경로는 서버측 RSC 핸들러
   (`react-router/rsc`, `matchRSCServerRequest`)다.
2. `apps/client`는 Vite SPA이며 RSC를 전혀 쓰지 않는다. 소스 전체에서
   `react-router/rsc`, `matchRSCServerRequest`, `unstable_*` import이 0건이고,
   실제 사용 심볼은 `BrowserRouter, Link, Navigate, Outlet, Route, Routes,
   useLocation, useNavigate, useParams, useSearchParams` 10개뿐이다.
   라우팅은 전부 클라이언트에서만 돌고 서버는 NestJS다.

**업그레이드하지 않은 이유:**

- `react-router@8.3.0`의 peer는 `react >= 19.2.7`, `react-dom >= 19.2.7`,
  engines `node >= 22.22.0`이다. 현재 클라이언트는 React 18.3이므로 8.x로
  가려면 **React 18 → 19 메이저 업그레이드**가 선행되어야 한다. 도달 불가능한
  위협을 막기 위한 대가로는 위험이 훨씬 크다.
- `npm audit fix --force`가 제안하는 대안은 `react-router-dom@7.11.0`으로의
  **다운그레이드**다. 7.12~7.18 7개 마이너에 담긴 버그 픽스를 되돌리는 것이라
  역시 순손실이다.

**재검토 트리거:** 아래 중 하나라도 참이 되면 즉시 재평가한다.

- 클라이언트가 React 19로 올라간 경우 → `react-router@^8.3.0`으로 상향
- `react-router` 7.x 패치 릴리스(7.18.3+)가 나온 경우 → 해당 버전으로 상향
- 애플리케이션이 RSC / SSR 라우팅을 도입하는 경우 → **즉시 차단 이슈로 승격**

## 참고 (취약점 아님)

- `npm ci` 시 `glob@10.5.0` deprecation 경고가 나온다. Advisory에 등록된
  취약점은 아니며(전이 의존성), 상위 패키지가 범위를 올려야 사라진다.
- `apps/server`의 `test/tickets-leak.test.mjs` 2개 assert가 실패하는데,
  의존성 변경 전(`main` @ `995b7f26` 원본 lockfile)에서도 동일하게 실패한다.
  **본 감사와 무관한 기존 실패**이므로 여기서 손대지 않았다.

## 검증

- `npm ci` — 성공 (520 packages)
- `npm run build` — server / client / agent-manager 3/3 성공
- `npm test -w client` — 230/230 pass
- `npm test -w awb-agent-manager` — 809 pass / 0 fail / 2 skip
- `npm test -w server` — 118/119 step pass (실패 1건은 위의 기존 실패)
- `npm audit` — 8건 → 2건 (남은 2건 = 위 react-router 1개 advisory)

## 배포 브랜치

`production.private`의 `package.json` / `package-lock.json`은 감사 시점에
`main`과 완전히 동일했다(직전 merge `f5adb453`). 따라서 `main`에 이 수정을
반영한 뒤 `production.private`로 merge하면 배포 경로도 동일하게 해소된다.
라이브 반영에는 운영자의 수동 rebuild + restart가 여전히 필요하다.

---

## 재검증 로그

### 2026-08-06 — 재검증 결과: 신규 취약점 0건, 조치 필요 없음

- 기준 커밋: `main` @ `276c3aa5` / 도구: `npm audit` (npm 11.11.0), GitHub Advisory DB
- `npm audit` (root, 워크스페이스 3개 전체, 580 packages): **high 2 / 그 외 0**
  — 위에서 "해당 없음"으로 승인한 `react-router` + `react-router-dom` 한 쌍
  (동일 advisory 1건)이 전부다. 2026-08-05 이후 **새로 뜬 advisory 없음.**
- 배포 브랜치 `production.private`: `git diff origin/main origin/production.private`
  결과가 `.github/workflows/deploy.yml` 1개 파일뿐 —
  `package.json` / `package-lock.json` / `apps/**` 는 `main`과 **바이트 단위로 동일**.
  즉 **lockfile drift 없음**, 배포 경로의 취약점 노출도 `main`과 같다.
- npm 배포 산출물 `awb-agent-manager`(v1.6.80)를 lockfile 없이 독립 해결해
  단독 감사: **0 vulnerabilities.** (소비자가 `npm i -g` 로 설치할 때의 트리)
- 재검토 트리거 재확인 — **셋 다 미충족, 예외 유지가 여전히 타당**:
  - `react-router` 7.x 패치 릴리스: 없음 (7.x 최신 = **7.18.2**, advisory 범위 `< 8.3.0`에 그대로 포함)
  - React 19 상향: 미실시 (client는 `react@18.3.1`, `react-router@8.3.0`의 peer는 `react >= 19.2.7`)
  - RSC / SSR 라우팅 도입: 없음 (아래 회귀 가드가 강제)
- 직접 의존성 40개의 lockfile 버전 대비 registry 최신 비교 — semver 범위 내에서
  뒤처진 것은 `tsx` 4.23.6 → 4.23.8 (devDependency, advisory 없음) 하나뿐.
  나머지 격차는 전부 메이저 업(React 19, TypeScript 7, typeorm 1.x 등)이라
  보안 사유로는 당기지 않는다.

**공급망 위생 점검(추가 실시, lockfile 580 엔트리 전수):**

| 항목 | 결과 |
| --- | --- |
| registry.npmjs.org 이외에서 resolve되는 패키지 (git/http/tarball URL) | 0건 |
| `integrity` 해시 누락 엔트리 | 0건 |
| install script 보유 패키지 | 5건 — `esbuild`, `fsevents`×3(macOS 전용 optional), `@scarf/scarf`(typeorm 전이 telemetry). 모두 알려진 정상 패키지 |
| deprecated 경고 | 1건 — `typeorm > glob@10.5.0`. 등록된 advisory 없음(메인테이너의 일괄 deprecate 문구), 상위 패키지가 범위를 올려야 사라짐 |
| override 고정값이 여전히 유효한가 | `multer@2.2.0`, `@hono/node-server@2.1.0`, `js-yaml@5.2.3`, `picomatch@4.0.5` — **전부 registry 최신과 일치**, 취약 버전으로 되돌아간 흔적 없음 |

**GitHub Actions:** `.github/workflows/` 의 `uses:` 는 전부 1st-party
`actions/checkout@v4` · `actions/setup-node@v4` (가변 태그 참조). commit SHA
고정이 더 엄격하긴 하나 GitHub 공식 액션에 한정되므로 이번엔 변경하지 않았다.

### 이번 재검증에서 추가한 것 — 승인된 예외의 회귀 가드

`react-router` 2건을 "해당 없음"으로 남겨둔 근거는 **"client가 unstable RSC API를
쓰지 않는다"** 는 사실 하나뿐인데, 그 사실을 지키는 장치가 없었다. 위 "재검토
트리거"는 산문이라 누군가 RSC/SSR 라우팅을 도입해도 아무도 모른 채 승인된
예외가 실재하는 high 취약점으로 바뀐다.

→ `apps/client/test/react-router-rsc-guard.test.mjs` 추가 (`npm test -w client`에 등록).
정적 스캔 5건으로 다음을 강제한다:

1. 스캔 대상이 실제로 존재하는지 자체 검증 (가드가 죽은 채 초록불만 내는 것 방지)
2. `react-router/rsc` 등 RSC 진입점 import 0건
3. `matchRSCServerRequest` / `RSCHydratedRouter` 등 RSC 서버 심볼 참조 0건
   (`unstable_` 접두사 형태 포함)
4. `react-router*` 에서 `unstable_*` 심볼 및 서브패스 import 0건
5. `apps/server`(NestJS)에 `react-router` 의존성·참조 0건

각 단언은 위반 코드를 임시로 심어 **실제로 실패하는 것까지 확인**했다.
이 테스트가 깨지면 완화하지 말고 "재검토 트리거" 절차(React 19 상향 후
`react-router@^8.3.0`, 또는 RSC 도입 철회)를 밟을 것.

### 2026-08-07 — 재검증 결과: 신규 advisory 0건 / **배포 트리 무결성 결함 1건 조치**

- 기준 커밋: `main` @ `5b257202` / 도구: `npm audit` (npm 11.11.0 / Node 24.14.1)
- `npm audit` (root, 워크스페이스 3개 전체, 580 packages): **high 2 / 그 외 0**
  — 전부 위에서 "해당 없음"으로 승인한 `react-router` + `react-router-dom`
  한 쌍(동일 advisory 1건). **신규 advisory 없음.**
- 배포 브랜치 `production.private`: `package-lock.json` blob 해시가 `main` 과
  **동일**(`5302708c`) — lockfile drift 없음. `package.json` 차이는
  `apps/server` 의 `test` / `test:qa` 스크립트 목록뿐(의존성 무관).
- 재검토 트리거 3종 재확인 — **여전히 셋 다 미충족**:
  - `react-router` 7.x 패치: 없음 (7.x 최신 = **7.18.2**, `dist-tags.version-7`
    도 7.18.2. advisory 범위 `>= 7.12.0, < 8.3.0` 에 그대로 포함)
  - React 19 상향: 미실시 (client `react@18.3.1`)
  - RSC / SSR 도입: 없음 (`react-router-rsc-guard` 가 강제)
- override 고정값 재확인: `multer@2.2.0` · `@hono/node-server@2.1.0` ·
  `js-yaml@5.2.3` · `picomatch@4.0.5` — **전부 registry 최신과 일치.**
- 직접 의존성 40개 대비 registry 최신 비교: semver 범위 내 지연은
  `tsx` 4.23.6→4.23.9, `vite` 8.2.0→8.2.1 둘뿐이고 **advisory 없음**.
  나머지 격차는 전부 의도적 메이저 보류(React 19 / TypeScript 7 / typeorm 1.x /
  jsdom 30 / @types/node 26). 보안 사유가 없으므로 lockfile 은 건드리지 않았다
  (근거 없는 재해결은 780라인급 churn 만 만들고 회귀 위험만 늘린다).
- 공급망 위생 재점검(lockfile 580 엔트리 전수): registry 외부 resolve 0건,
  `http://` resolve 0건, `integrity` 누락 0건, install script 5건
  (`esbuild`, `fsevents`×3, `@scarf/scarf`) — 2026-08-06 과 동일.

#### 조치 1 (핵심) — 배포 이미지가 감사한 lockfile 트리가 아니었다

`Dockerfile` 의 runner 스테이지가 런타임 의존성을 이렇게 설치하고 있었다:

```dockerfile
RUN npm install --omit=dev --workspace=server
```

`npm install` 은 lockfile 을 **강제하지 않고 제안으로만** 취급한다. 즉:

1. 같은 커밋을 다시 빌드해도 선언 범위(`^`) 안에서 다른 버전이 잡힐 수 있다.
   → `npm audit` 으로 감사한 트리와 실제로 배포된 트리가 같다는 보장이 없다.
   감사 결과가 배포본에 대해 아무것도 말해주지 못하는 상태였다.
2. `integrity` 해시 불일치 시에도 실패하지 않는다 — lockfile 이 갖고 있는
   tarball 변조 탐지가 배포 경로에서만 무력화돼 있었다.

**재현 검증:** runner 스테이지의 파일 레이아웃(루트 `package.json` +
`package-lock.json` + `apps/server/package.json` 만)을 그대로 만들어 실행한 결과,
`npm install` 은 컨테이너 안의 `package-lock.json` 을 **1743 라인 덮어썼다**
(워크스페이스가 `extraneous` 로 표시되고 dev 엔트리가 제거됨). `npm ci` 는
같은 레이아웃에서 exit 0, **lockfile 바이트 단위 무변경**.

→ `RUN npm ci --omit=dev --workspace=server` 로 변경.

**동작 변화 없음까지 확인:** 두 방식의 설치 결과 `node_modules` 트리를 전수
비교(패키지명@버전)한 결과 **양쪽 200개 패키지 완전 일치** — 한쪽에만 있는
패키지 0건, 버전 불일치 0건. 즉 이 변경은 배포되는 코드를 바꾸지 않고
"감사 대상 == 배포 대상" 보장만 추가한다.

(`npm ci --workspace=server` 가 이 축소된 레이아웃에서 lockfile out-of-sync
오류를 낼 것 같지만, 실제로는 나지 않는다는 것을 위 재현으로 확인했다.
이것이 원래 `npm install` 이 쓰였을 법한 이유다.)

#### 조치 2 — `@scarf/scarf` 설치 시점 telemetry 차단

`swagger-ui-dist` → `@scarf/scarf@1.4.0` 이 **런타임 프로덕션 트리에 포함**되며
`postinstall: node ./report.js` 로 설치할 때마다 scarf.sh 에 비콘을 쏜다
(패키지명/버전/OS/arch/CI 여부). 취약점은 아니지만 CI 와 Docker 빌드
컨테이너에서 나가는 불필요한 아웃바운드다.

→ 루트 `package.json` 에 `"scarfSettings": { "enabled": false }` 추가.
`report.js:57` 의 공식 opt-out 경로(`rootPackage.scarfSettings.enabled === false`)를
직접 확인했고, 이 필드가 `npm ci` 의 lockfile 동기화를 깨지 않는 것도
실제 `npm ci` 실행으로 검증했다(lockfile 무변경, exit 0).

#### 이번 재검증에서 추가한 것 — 공급망 무결성 회귀 가드

`apps/server/test/supply-chain-integrity-guard.test.mjs` (`npm test -w server` 에 등록).
위 두 조치와 위생 점검 결과를 산문이 아니라 기계 검사로 고정한다:

1. 스캔 대상이 실제로 존재하는지 자체 검증 (가드가 죽은 채 초록불 방지)
2. `Dockerfile` 에 의존성 설치용 `npm install` 0건 + `npm ci` 최소 2회
3. lockfile 전 엔트리가 `https://registry.npmjs.org/` 에서 resolve
4. lockfile 전 엔트리가 `integrity` 해시 보유
5. install script 보유 패키지가 허용 목록(`esbuild`/`fsevents`/`@scarf/scarf`) 밖으로 안 늘어남
6. 루트 `package.json` 의 scarf opt-out 유지

단언 6개 각각에 위반을 임시로 심어 **실제로 실패하는 것까지 확인**했다
(Dockerfile 되돌리기 / scarfSettings 제거 / `resolved` 를 `git+ssh://` 로 변경 /
`integrity` 제거 / `hasInstallScript` 추가 / lockfile 엔트리 절단).

#### 미조치 — 운영자 승인이 필요한 항목 (배포 브랜치)

`production.private` 전용 `.github/workflows/deploy.yml` 의 마지막 스텝:

```yaml
- name: Deploy to NAS
  uses: appleboy/ssh-action@v1        # ← 가변 태그
  with:
    key: ${{ secrets.NAS_SSH_KEY }}
    password: ${{ secrets.NAS_PASSWORD }}
```

`appleboy/ssh-action` 은 **개인 계정 소유의 서드파티 액션**이고 `@v1` 은
가변 태그다. 소유자 계정이 탈취되거나 태그가 재지정되면, 그 시점부터
`NAS_SSH_KEY` / `NAS_PASSWORD` / `NAS_HOST` 가 공격자 코드에 그대로 넘어간다.
`docker/setup-buildx-action@v4` · `docker/login-action@v4` ·
`docker/build-push-action@v7` 도 같은 성격(가변 태그)이며 `GHCR_TOKEN` 을 본다.
표준 완화는 **full commit SHA 고정**이다.

`main` 쪽 워크플로(`ci.yml`, `publish-agent-manager.yml`)는 GitHub 1st-party
`actions/checkout@v4` · `actions/setup-node@v4` 뿐이라 위험도가 다르다.

**이번에 고치지 않은 이유:** `deploy.yml` 은 `production.private` 에만 있고,
이 브랜치로의 push 자체가 NAS 실배포를 트리거한다. 보안 위생 목적의 커밋
하나로 프로덕션 배포를 발생시키는 것은 운영자 승인 사항이라 판단해
조치를 보류하고 여기에 기록만 남긴다. 승인 시 각 `uses:` 를 해당 태그가
가리키는 commit SHA 로 치환(`uses: appleboy/ssh-action@<sha>  # v1.2.3`)하면 된다.

#### 검증

- `npm run build` (turbo, 3 tasks) — 통과
- `npm test -w server` — 통과 (실패 1건은 `tickets-leak.test.mjs` 의 기존 실패,
  손대지 않은 lockfile 로도 재현되는 사전 결함)
- `npm ci --omit=dev --workspace=server` 를 runner 레이아웃에서 실제 실행 — exit 0,
  lockfile 무변경, 설치 트리 200개 패키지 기존과 동일

### 2026-08-08 — 재검증 결과: **취약점 0건** / react-router 건 해소 / 전일 조치 랜딩

- 기준 커밋: `main` @ `b89b39b0` / 도구: `npm audit` (npm 11.11.0 / Node 24.14.1)
- `npm audit` (root, 워크스페이스 3개 전체, 579 packages):
  **critical 0 / high 0 / moderate 0 / low 0 — 총 0건.**
- `apps/agent-manager` 독립 트리: **0건.**

#### 0건이 "감사 실패"가 아님을 먼저 증명했다

전일까지 high 2건이던 것이 0건으로 떨어졌으므로, 이게 진짜 해소인지
아니면 audit 엔드포인트가 조용히 실패해 빈 결과를 준 것인지부터 갈랐다.
별도 임시 디렉터리에 **알려진 취약 패키지**(`lodash@4.17.4`)만 있는 트리를
만들어 `npm audit` 을 돌린 결과 `1 critical severity vulnerability` 를
정상 보고 — 레지스트리 advisory 조회 경로는 살아 있다. 따라서 0건은 실제 값이다.
(이 저장소의 `react-router` 버전은 어제와 동일한 7.18.2 로 **변한 게 없다** —
바뀐 건 advisory 쪽이다. 이 대조 검증 없이는 구분이 불가능했다.)

#### react-router GHSA-qwww-vcr4-c8h2 — 승인된 예외 → **해소**

GitHub advisory API 직접 조회 결과, advisory 가 `2026-08-07T18:16:54Z` 에
개정되면서 영향 범위가 다음과 같이 바뀌었다:

| | 개정 전 | 개정 후 |
|---|---|---|
| `react-router` | `>= 7.12.0, < 8.3.0` | `>= 7.12.0, < 7.18.2` / `>= 8.0.0, < 8.3.0` |
| 7.x first patched | (없음) | **7.18.2** |
| `react-router-dom` | 대상 | **대상에서 제외** |

즉 7.x 계열에도 패치 버전이 지정됐고 그게 이 저장소가 이미 쓰던 7.18.2 다.
**의존성 변경 없이 해소**됐다 — React 19 상향도, 8.3.0 상향도, 7.11.0
다운그레이드도 필요 없었다. 전일까지 문서가 "패치 릴리스는 8.3.0 뿐"이라고
적은 것은 그 시점 advisory 메타데이터 기준으로는 옳았다.

**방어선 이동에 따른 가드 갱신** — 예전 근거는 "RSC 를 안 쓰니 해당 없음"
이었지만 이제 실제 보호막은 **7.18.2 이상이라는 버전 사실**이다. 7.18.1 이하로
되돌아가면(롤백 / lockfile 수동 편집 / resolution 고정) RSC 사용 여부와 무관하게
다시 취약 범위다. `apps/client/test/react-router-rsc-guard.test.mjs` 에 단언
`react-router stays at or above the patched 7.18.2` 를 추가해 이 바닥을 강제한다
(8.x 로 올라갈 경우의 바닥 8.3.0 도 같이 검사). lockfile 의 `react-router` 를
7.18.1 로 임시 변조해 **실제로 실패하는 것까지 확인**했고, 변조는 되돌렸다
(lockfile diff 0라인). 기존 RSC 스캔 단언 4종은 심층 방어로 그대로 유지한다.

#### 전일(2026-08-07) 조치가 랜딩되지 않은 상태였다 — 이번에 랜딩

2026-08-07 감사가 만든 변경(`npm ci` 전환 · scarf opt-out · 공급망 가드
테스트 · 문서)은 워크트리에 **커밋되지 않은 채 남아 있었고** `main` 에는
반영돼 있지 않았다(당시 `main` @ `5b257202` → 현재 `b89b39b0`, 45 커밋 진행).
즉 배포 이미지는 여전히 `RUN npm install --omit=dev --workspace=server` 였다.
해당 변경을 현재 `main` 위에 재적용해 이번 커밋으로 함께 랜딩한다.
그 사이 45 커밋에서 `package.json` / `package-lock.json` 은 건드려지지 않아
(유일한 변경은 `apps/server/package.json` 의 테스트 목록) 전일 분석은 그대로 유효하다.

#### 공급망 위생 — 전일과 동일, 회귀 없음

- lockfile 573 엔트리 전수: registry 외부 resolve **0건**, `integrity` 누락 **0건**,
  install script **3종**(`esbuild`, `fsevents`, `@scarf/scarf`)으로 허용 목록과 일치.
- override 고정값 전부 유지·정상 해결: `multer@2.2.0` · `@hono/node-server@2.1.0` ·
  `js-yaml@5.2.3` · `picomatch@4.0.5`.

#### 배포 브랜치 `production.private`

`package.json` / `package-lock.json` 이 `main` 과 **blob 해시까지 동일**
(`485b9705` / `5302708c`) — **의존성 drift 없음**. 소스 기준 45 커밋 뒤처져
있으나 의존성 관련 차이는 0이므로 이번 감사 목적의 머지는 불필요하다.

#### 미조치 — 이월 (운영자 승인 필요)

`production.private` 의 `deploy.yml` 서드파티 액션 가변 태그(`appleboy/ssh-action@v1`
등) SHA 고정 건은 전일과 동일한 이유(해당 브랜치 push = NAS 실배포 트리거)로
이월한다. 위 2026-08-07 절의 "미조치" 항목 참조.

#### 검증

- `node --test apps/client/test/react-router-rsc-guard.test.mjs` — 6/6 통과
- `node --test apps/server/test/supply-chain-integrity-guard.test.mjs` — 6/6 통과
- 신규 단언 mutation 검증(7.18.1 강등 → 실패 재현 → 원복) 완료
- `npm run build` / `npm test -w server` — 아래 커밋 검증 절차대로 실행

---

### 2026-08-09 재검증 — `main` 0건 유지, **배포 브랜치 공급망 하드닝 누락 발견·조치**

- 기준 커밋: `main` @ `120fb6ad`, `production.private` @ `8599097a`
- 결과: **`main` 0건, `production.private` lockfile 0건** (dev 포함, 579 패키지)

#### 감사 경로 생존 확인 (0건을 믿기 전에)

`npm audit` 이 조용히 실패해도 "0 vulnerabilities" 를 반환하므로, 임시 트리에
`lodash@4.17.4` 를 심어 별도 감사를 돌렸다 → **critical 1건 정상 검출**.
따라서 이번 0건은 실제 결과이지 감사 경로 장애가 아니다.

#### 이번 감사의 실제 발견 — 감사 대상 트리 ≠ 배포 트리

전일(2026-08-08) 감사는 `package.json` / `package-lock.json` 이 blob 단위로
동일하다는 이유로 "의존성 drift 없음 → 머지 불필요" 로 결론냈다. 그러나 **lockfile
동일성만으로는 배포 트리의 동일성이 보장되지 않는다.** `production.private` 의
`Dockerfile` 런타임 스테이지는 여전히

    RUN npm install --omit=dev --workspace=server

였다. `npm install` 은 lockfile 을 "제안" 으로만 취급해 semver 범위 안에서 다시
해결하고 컨테이너 안의 lockfile 을 덮어쓴다. 즉 **`main` 에서 0건으로 감사한 트리와
실제 배포 이미지의 트리가 같다는 보장이 없었다.** 2026-08-07 에 이 문제를 고친
`npm ci` 전환은 `main` 에만 랜딩되어 있었고, 배포 브랜치에는 이틀째 반영되지 않은
상태였다.

같은 이유로 다음 하드닝도 배포 브랜치에 누락되어 있었다.

| 항목 | `main` | 조치 전 `production.private` |
| --- | --- | --- |
| `Dockerfile` 런타임 설치 | `npm ci --omit=dev` | `npm install --omit=dev` |
| `@scarf/scarf` 설치 시점 텔레메트리 옵트아웃 (`scarfSettings`) | 있음 | **없음** |
| `supply-chain-integrity-guard.test.mjs` | 있음 | **없음** |

**조치:** `origin/main` 을 `production.private` 로 머지해 배포 브랜치를 동기화했다
(`f0d30185`). 충돌 없음, `deploy.yml` 보존, 머지 후 `git diff origin/main
origin/production.private` 는 `deploy.yml` 197줄 추가 단독.

교훈: 배포 브랜치 점검은 lockfile 비교만으로 끝내지 말고 **의존성을 설치하는 경로
(`Dockerfile` / CI)** 까지 함께 볼 것. 이 항목은 위 가드 테스트가 상시 강제한다.

#### 공급망 위생 — 회귀 없음

- lockfile 580 엔트리 전수: registry 외부 resolve **0건**(워크스페이스 링크 3건 제외),
  `integrity` 누락 **0건**, git/tarball 의존성 **0건**.
- install script: `esbuild` · `fsevents` · `@scarf/scarf` 3종으로 허용 목록과 일치
  (`@scarf/scarf` 는 `scarfSettings.enabled=false` 로 무력화됨).
- override 고정값 전부 레지스트리 최신과 일치하며 정상 해결:
  `multer@2.2.0` · `@hono/node-server@2.1.0` · `js-yaml@5.2.3` · `picomatch@4.0.5`.
- deprecated: `typeorm` 하위 전이 의존성 `glob@10.5.0` 1건 — advisory 없음, 직접
  제어 불가(상위 릴리스 대기). 감시만 한다.
- 범위 내 지연(in-range lag): `turbo` 2.10.7 → 2.10.9 (dev 전용, advisory 없음).
  lockfile 재생성은 배포 브랜치 재동기화를 유발하므로 advisory 없는 dev 도구 지연은
  이번에도 조치하지 않는다.

#### 미조치 — 이월 (운영자 승인 필요)

`production.private` `deploy.yml` 의 서드파티 액션 가변 태그 SHA 고정:
`docker/setup-buildx-action@v4`, `docker/login-action@v4`,
`docker/build-push-action@v7`, `appleboy/ssh-action@v1`. 태그는 재배치 가능하므로
공급망 관점에서는 SHA 고정이 옳지만, 잘못된 SHA 고정은 NAS 실배포 파이프라인을
망가뜨린다. `main` 의 워크플로는 1st-party `actions/*` 만 사용한다.

#### 검증

- 캐너리 감사(`lodash@4.17.4`) → critical 1건 검출, 감사 경로 정상
- `npm audit` — `main` 0건 / `production.private` 0건 (머지 후 재감사도 0건)
- `node --test apps/server/test/supply-chain-integrity-guard.test.mjs
  apps/client/test/react-router-rsc-guard.test.mjs` — 머지된 배포 브랜치에서 **12/12 통과**
  (머지 전이라면 `Dockerfile installs dependencies only through npm ci` 가 실패했을 것)
- `npm run build` — 3/3 성공
