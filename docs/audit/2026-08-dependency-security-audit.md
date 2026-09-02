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

---

### 2026-08-10 재감사 — `npm audit` 0건, 발행 측 공급망 구멍 1건 조치

`main` 은 `68035c51` 기준. **`npm audit` 은 0건이고 lockfile 도 직전 감사 이후
바뀌지 않았다** — 그래서 이번 발견은 audit 바깥에 있다.

#### 발견 — `awb-agent-manager` 가 provenance 없이 발행되고 있었다

이 저장소의 기존 공급망 가드는 전부 **받는 쪽** 방어다(레지스트리 고정, integrity
해시, install script 허용목록, `npm ci`). 그런데 이 저장소는 npm 에
`awb-agent-manager` 를 **발행**하고, live host 들이 그것을 `npm i -g` 로 설치해
fleet 전체를 돌린다. 즉 우리 패키지가 남의 신뢰 루트다. 그쪽은 무방비였다.

레지스트리 조회 결과 (`npm view awb-agent-manager`, 당시 latest `1.6.95`):

    dist.signatures    : 있음   ← 레지스트리가 서명한 것 (npm 이 자동으로 함)
    dist.attestations  : 없음   ← provenance. 우리가 발행해야 하는 것

`dist.signatures` 는 "레지스트리가 이 바이트를 갖고 있다"만 증명한다. 발행 주체가
정말 이 저장소인지는 말해주지 않는다. `NPM_TOKEN`(Automation 토큰, 2FA 우회) 이
유출되면 공격자가 동일한 이름으로 임의 tarball 을 올려도 소비자가 구분할 수단이
없고, self-update 경로상 fleet 전체가 그것을 자동으로 집어간다.

원인은 워크플로 2줄이었다.

    permissions:
      contents: write            # id-token: write 없음
    ...
    run: npm publish -w awb-agent-manager --access public   # --provenance 없음

#### 조치

`.github/workflows/publish-agent-manager.yml`:

- `permissions` 에 `id-token: write` 추가 (Sigstore 증명 발급용 OIDC 토큰)
- publish 명령에 `--provenance` 추가

이제 소비자가 `npm audit signatures` 로 "레지스트리의 이 버전이 정말
`parnmanas/ai-workflow-board` 의 이 커밋에서 이 워크플로로 빌드됐는지" 검증할 수 있다.

**전제조건 사전 확인 (하나라도 어긋나면 publish 가 실패하므로 코드 수정 전에 확인함):**

| 전제 | 확인 결과 |
| --- | --- |
| 저장소가 public (provenance 는 Sigstore 공개 투명성 로그에 기록됨) | ✅ `visibility: PUBLIC` |
| `package.json.repository` 가 실제 빌드 저장소를 가리킴 | ✅ `git+https://github.com/parnmanas/ai-workflow-board.git` |
| GitHub Actions 에서 발행 | ✅ |
| npm ≥ 9.5 | ✅ node 22 (npm 10.x) |

저장소가 private 였다면 `--provenance` 는 발행을 **깨뜨린다**. 이 확인 없이 넣지 말 것.

#### 회귀 가드

`apps/server/test/supply-chain-integrity-guard.test.mjs` 에 3건 추가 (6 → 9 asserts):

1. 워크플로의 모든 `npm publish` 실행 줄이 `--provenance` 를 넘긴다
2. `permissions.id-token: write` 가 있다 (없으면 provenance publish 가 실패)
3. agent-manager `package.json.repository` 가 이 저장소를 가리킨다

YAML 주석은 파싱 전에 제거한다 — 주석 안의 `--provenance` 가 가드를 통과시키면
안 된다. job 표시 이름(`name: compute version + npm publish`) 오탐도 있어서
실행 줄(`run:` 또는 `run: |` 블록 내부)만 검사한다.

**가드가 실제로 무는지 확인함:** 워크플로 변경을 되돌리고 돌리면 새 assert 2건이
정확히 실패하고, 복원하면 9/9 통과한다.

#### 그 외 — 회귀 없음

- **캐너리 먼저:** `lodash@4.17.4` 임시 트리 → critical 1건. advisory 경로가 살아
  있음을 확인한 뒤에야 `main` 의 0건을 신뢰했다.
- `npm audit`: `main` 0건 (prod 270 / dev 308 / optional 63, 총 579).
- `awb-agent-manager` 독립 트리(발행되는 그 패키지) 단독 감사: 135 의존성, **0건**.
- lockfile 580 엔트리 전수: registry 외부 resolve 0건, `integrity` 누락 0건,
  미해결 엔트리 0건. install script 는 허용목록(`esbuild`/`fsevents`/`@scarf/scarf`)과 일치.
- override 4종 전부 유효: `multer` · `@hono/node-server` · `js-yaml` · `picomatch`.
- 직접 의존성 버전 지연 중 advisory 있는 것 **없음**. 범위 밖 major 지연은 전부 기존
  판단 유지 — `react`/`react-dom` 18.3.1(→19.x), `typeorm` 0.3.31(→1.1.0),
  `@hello-pangea/dnd` 17(→18). `turbo` 2.10.7→2.10.9 in-range dev 지연도 종전대로 미조치.
- `main` 워크플로의 액션은 여전히 1st-party `actions/*` 만 사용.

#### 배포 브랜치 (`production.private`)

- `package.json` · `package-lock.json` · `apps/client/package.json` — `main` 과 **바이트 동일**.
- `apps/server/package.json` 차이는 테스트 등록 목록뿐 — **의존성 변경 없음**.
- `Dockerfile` 은 차이 없음 (양쪽 스테이지 모두 `npm ci`). 2026-08-09 에 지적한
  설치 경로 드리프트는 재발하지 않았다.
- **이번 변경은 배포 브랜치에 머지하지 않았다.** 바뀐 것은 발행 워크플로와 테스트뿐이고
  발행 워크플로는 `main` push 에만 트리거된다 — 런타임 영향이 0인 변경 때문에
  `production.private` 를 push 해 NAS 실배포를 유발할 이유가 없다. 다음 기능 머지 때
  자연히 따라간다.

#### 이월 (변동 없음, 운영자 승인 필요)

`production.private` `deploy.yml` 서드파티 액션(`docker/*`, `appleboy/ssh-action`)
SHA 고정 — 잘못된 SHA 는 실배포 파이프라인을 깨므로 여전히 승인 대기.

#### 검증

- 캐너리(`lodash@4.17.4`) → critical 1건 — 감사 경로 정상 확인
- `npm audit` — `main` 0건 / agent-manager 독립 트리 0건
- `node --test apps/server/test/supply-chain-integrity-guard.test.mjs` — **9/9 통과**
  (변경 되돌리면 새 assert 2건이 실패하는 것까지 확인)
- `node --test apps/client/test/react-router-rsc-guard.test.mjs` — 6/6 통과
- 워크플로 YAML 파싱 확인: `permissions={contents:write,id-token:write}`,
  publish 명령 = `npm publish -w awb-agent-manager --access public --provenance`

> **참고:** 이 커밋은 `publish-agent-manager.yml` 을 건드리므로 워크플로의 `paths`
> 필터에 걸려 `main` 랜딩 시 publish 가 1회 트리거된다(버전 자동 계산). 이는 이
> 저장소의 정상 동작이며, 그 run 이 곧 provenance 변경의 실검증이 된다.

---

## 2026-08-12 재감사 — CI 워크플로 GITHUB_TOKEN 최소권한 누락

### 결론

`npm audit` 기준 취약점은 **`main` · 배포 브랜치 · 발행 패키지 모두 0건**이고, 종전 조치
(`npm ci` 설치 경로, lockfile 무결성, scarf opt-out, npm provenance)는 전부 유지되고 있다.
이번 조치 대상은 **패키지 버전이 아니라 그 패키지들을 설치·실행하는 CI 잡의 권한**이다.

### 발견 — `ci.yml` 에 `permissions:` 블록이 없었다

`permissions:` 를 선언하지 않은 워크플로의 `GITHUB_TOKEN` 은 **저장소 기본 설정**을
물려받는다. 기본값이 "read and write" 인 저장소에서는 `ci.yml` 의 5개 잡 전부가
contents/packages 등에 쓰기 가능한 토큰을 들고 돌게 된다.

이 워크플로가 무엇을 실행하는지가 문제다:

- `npm ci` — 서드파티 의존성의 install script 실행(`esbuild`/`fsevents`/`@scarf/scarf`)
- `apps/server` 전체 스위트 · agent-manager 전체 스위트 · client 스위트 — **PR 브랜치의 코드**
- 트리거에 `pull_request` 포함

즉 **신뢰할 수 없는 코드가 쓰기 토큰과 같은 프로세스 트리 안에 있었다.** 의존성 하나가
탈취되면 그 install script 가 `$GITHUB_TOKEN` 으로 `main` 을 밀거나 릴리스를 조작할 수 있고,
`main` push 는 `publish-agent-manager.yml` 을 트리거해 npm 으로, 다시 live host 의
`npm i -g` self-update 를 통해 fleet 전체로 번진다. 지금까지의 감사가 공들여 막아온
공급망 경로(provenance·lockfile 무결성)를 **우회하는** 경로였다.

이 저장소의 발행 워크플로는 이미 최소권한을 지키고 있었다(`contents: write` +
`id-token: write`, 태그 push 와 provenance 때문에 실제로 필요). 소비 측 `ci.yml` 만
빠져 있었다.

### 조치

1. `.github/workflows/ci.yml` 에 top-level `permissions: contents: read` 선언.
   명시하지 않은 나머지 스코프는 전부 `none` 으로 떨어진다. `ci.yml` 의 어떤 잡도
   쓰기를 하지 않고 secrets 도 참조하지 않으므로 동작 변화는 없다. 저장소 기본값이
   나중에 바뀌어도 이 선언이 이겨서 blast radius 가 파일 안에 고정된다 — 저장소 설정은
   코드 리뷰에 잡히지 않으므로 방어는 워크플로 파일에 있어야 한다.
2. `apps/server/test/supply-chain-integrity-guard.test.mjs` 에 assert 3건 추가(9 → 12):
   - 모든 워크플로가 `permissions:` 를 명시할 것 (주석 안의 `permissions:` 는 불인정)
   - `ci.yml` 은 top-level `contents: read` 로 고정 + write 스코프 0건
   - `ci.yml` 이 secrets 를 참조하기 시작하면 실패 — `pull_request` 워크플로가 secrets 를
     다루기 시작하면 이 read-only 판단 자체를 재검토해야 하기 때문

### 감사 범위 및 결과

- **캐너리** (`lodash@4.17.4` → critical 1건): advisory 경로 정상 동작 확인 후에만 0건을 신뢰.
- **`npm audit` (`main`)**: 0건 (prod 270 / dev 308 / optional 63, 총 579).
- **`awb-agent-manager` 독립 트리**(실제 발행되는 그 패키지): 135 의존성, **0건**.
- **lockfile 580 엔트리 전수**: registry 외부 resolve 0건, `integrity` 누락 0건,
  install script 는 허용목록과 정확히 일치.
- **발행 provenance 유지 확인**: `awb-agent-manager@1.6.97` 이
  `attestations.provenance` (SLSA v1) 보유 — 2026-08-10 조치가 계속 살아 있다.
- **`npm audit signatures`**: 검증 실패 0건 (단 이 명령은 트리 전체가 아니라 서명이
  게시된 일부만 감사한다 — "전수 검증" 으로 읽지 말 것).
- **배포 브랜치 (`production.private`)**: `package.json` · `package-lock.json` ·
  `Dockerfile` 모두 `main` 과 **바이트 동일**(양 스테이지 `npm ci` 유지).
  `apps/server/package.json` 차이는 테스트 등록 목록뿐 — 의존성 변경 없음.
  나머지 차이는 미머지 기능(CI red 감시)과 `deploy.yml` 로 보안 무관.
- **이번 변경은 배포 브랜치에 머지하지 않았다.** 바뀐 것은 `main` 전용 CI 워크플로와
  테스트뿐이고 런타임 산출물 영향이 0이다 — NAS 실배포를 유발할 이유가 없다.

### 이월 (변동 없음, 운영자 승인 필요)

`production.private` `deploy.yml` 서드파티 액션(`docker/*`, `appleboy/ssh-action`)
SHA 고정. 잘못된 SHA 는 실배포 파이프라인을 깨고, 그 브랜치 push 자체가 실배포를
트리거하므로 여전히 승인 대기.

### 검증

- `node --test apps/server/test/supply-chain-integrity-guard.test.mjs` — **12/12 통과**.
  `ci.yml` 수정을 되돌리면 **새 assert 정확히 2건만** 실패하는 것까지 확인(가드가 실제로 문다).
- `node --test apps/client/test/react-router-rsc-guard.test.mjs` — 6/6 통과.
- 워크플로 YAML 파싱 확인: `ci.yml` → `{contents: read}`, 잡 5개 그대로.
  `publish-agent-manager.yml` → `{contents: write, id-token: write}` 변동 없음.
- 이 커밋은 `publish-agent-manager.yml` 을 건드리지 않으므로 publish 를 트리거하지 않는다.

---

## 2026-08-13 재감사 — 의존성은 깨끗, 발견은 **GitHub API path injection**

`npm audit` 은 `main` · `production.private` · 발행 패키지 모두 **0건**이었고, 이전
감사가 세운 가드도 전부 살아 있었다. 이번 발견은 의존성이 아니라 **우리 코드가
호출자 입력을 REST 경로에 그대로 보간하던 자리**에서 나왔다.

### 취약점 (수정됨)

`apps/server/src/services/github-connector.service.ts` 는 GitHub REST 경로를 전부
템플릿 문자열로 조립하면서, `branch` · `workflowId` · `runId` · `base` · `head` 는
`encodeURIComponent` 로 감쌌지만 **`owner` 와 `repo` 는 18개 호출 지점 어디에서도
검증하거나 인코딩하지 않았다.**

진입점인 `fetch_github_info` MCP 도구는 `owner` / `repo` 를 자유 문자열
(`z.string()`)로 받는다. WHATWG URL 정규화가 `..` 세그먼트를 조용히 접기 때문에:

```
owner = "x"
repo  = "../../user/repos?visibility=private&"
  → https://api.github.com/repos/x/../../user/repos?visibility=private&
  → https://api.github.com/user/repos?visibility=private&    (실측 확인)
```

요청은 `/repos/...` 밖의 **임의 GitHub 엔드포인트로 재조준**되며, 그대로 서버가
보관한 GitHub 토큰(또는 호출자가 지정한 `credential_id` 의 자격증명)을 달고 나간다.
즉 **MCP 키를 가진 호출자가 직접 쥘 수 없는 토큰의 권한으로 비공개 저장소 목록 등을
읽어낼 수 있었다.** `createIssue` / `closeIssue` 같은 POST·PATCH 경로도 같은 방식으로
재조준 가능했다. `parseGitHubUrl` 의 `owner` 패턴(`[^/]+`)도 `..` 를 허용해 URL
경로로 들어오는 값에 같은 구멍이 있었다.

### 조치 — 2겹 방어

1. **진입점 charset 검증** — `assertRepoRef()` / `isValidRepoRef()` 를 추가하고
   `owner`(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`) · `repo`(`^[A-Za-z0-9_.-]{1,100}$`,
   `.`·`..` 제외)를 GitHub 자체 명명 규칙에 맞춰 고정했다. 모듈 함수 6개
   (`listOpenIssuesSince` · `listIssueCommentsSince` · `compareCommits` ·
   `createIssueComment` · `createIssue` · `closeIssue`)는 throw 하고,
   기존에 `''`/`[]` 로 degrade 하던 서비스 메서드 4개는 **degrade 계약을 유지한 채**
   기존 인자 가드 옆에 검증을 붙였다(동작 호환). MCP 도구가 직접 타는
   `fetchRepoInfo` 는 throw — "not found" 가 아니라 잘못된 입력으로 보고된다.
   이 층이 반드시 필요한 이유: 중앙 가드는 `?` 이후를 보지 않으므로
   `repo="y?foo=bar"` 같은 **질의 주입은 진입점에서만 막힌다.**
2. **송신 직전 최종 가드** — `assertGitHubApiUrl()` 이 정규화 후 origin 과
   traversal 세그먼트(`.` · `..` · `%2e` · `%2e%2e`)를 재검사하고 절대 URL 을
   반환한다. `githubApiCall`, `githubFetch`, 그리고 유일하게 남아 있던 raw
   `fetch`(README 조회)까지 **모든 송신 경로가 이 함수를 통과**하므로 앞으로 추가될
   호출 지점도 자동으로 덮인다. traversal 만 명시적으로 거부하고 정규화 결과를
   원문과 문자열 비교하지는 않는다 — 그러면 `encodeURIComponent` 로 이미 인코딩된
   세그먼트(`release%2F1.0`)에서 오탐이 난다.

`parseGitHubUrl` 도 같은 charset 을 적용해, 파싱은 되지만 규칙을 벗어나는 값은
REST 경로로 넘기지 않고 `null` 로 거부한다.

### 검증

- 새 회귀 테스트 `apps/server/test/github-repo-ref-injection.test.mjs` (6 테스트) —
  `npm test -w server` 의 `posttest` 목록에 등록(`ssrf-guard` · `auth-login-throttle` 옆).
- **가드가 실제로 무는지 확인**: traversal 검사와 `repo` charset 을 일부러 무력화해
  재빌드 → **정확히 주입 관련 3건만** 실패, 나머지 3건은 통과. 원복 후 6/6 통과.
- 익스플로잇 자체를 실측: 수정 전 URL 이 `https://api.github.com/user/repos?visibility=private&`
  로 정규화되는 것을 확인한 뒤, 수정 후 같은 입력이 거부되는 것을 테스트로 고정했다.
- 회귀 없음: `ssrf-guard` · `supply-chain-integrity-guard` · `outreach-github-connector` ·
  `github-sync-credential` · `ci-health-monitor`(+presence) · `outreach-ingest` ·
  `outreach-publish-behavior` · `outreach-release-consistency` ·
  `test-registration-completeness` — 합계 **128 테스트 전건 통과**.

### 의존성 감사 결과 (변동 없음)

- `main` · `production.private` 추출 트리 · `awb-agent-manager` 단독 트리 — 모두 **0건**.
- **카나리 확인**: 임시 트리 `lodash@4.17.4` → critical 1건 정상 보고 —
  "0건" 이 감사 경로 무응답이 아님을 증명.
- 락파일 위생: 581 항목, 전부 `registry.npmjs.org` + integrity 보유
  (워크스페이스 심링크 3건 제외). 설치 스크립트는 허용 목록
  (`@scarf/scarf` · `esbuild` · `fsevents`) 그대로. deprecated 는 typeorm 하위
  `glob@10.5.0` 뿐 — 어드바이저리 없음, 직접 통제 불가.
- 발행 provenance 유지: `awb-agent-manager@1.6.115` 가 `attestations.provenance`
  (SLSA v1) 보유.
- `main` 워크플로는 여전히 1st-party `actions/*` 만 사용.

### 배포 브랜치 드리프트 — **운영자 판단 필요 (미조치)**

이번에는 `production.private` 이 `main` 과 **바이트 동일하지 않다.** 락파일이
15줄 벌어져 있고, 그 정체는 배포 브랜치에 **보안 통제 3종이 통째로 빠져 있다**는 것:

| 통제 | `main` | `production.private` |
|---|---|---|
| helmet 보안 응답 헤더 (nosniff/frameguard/HSTS/CSP) | 있음 (`main.ts`) | **없음** (의존성조차 없음) |
| SSRF 가드 (`common/ssrf-guard.ts`) | 있음 | **없음** |
| 로그인 무차별 대입 잠금 (5회/15분, email+IP) | 있음 (`auth.service.ts`) | **없음** |

회귀 테스트 `ssrf-guard` · `auth-login-throttle` · `mcp-tool-authz` ·
`mcp-standalone-http-auth` · `supply-chain-integrity-guard` 도 배포 브랜치에 없다.
두 브랜치의 `package.json` / 락파일은 각자 일관되므로 `npm ci` 는 정상 동작한다 —
**깨진 상태가 아니라 "뒤처진" 상태**다.

조치(= `main` → `production.private` 머지)는 **하지 않았다.** 이 머지는 보안 통제
3종만이 아니라 진행 중인 기능 커밋 79개 파일을 함께 실 NAS 로 내보내며, 브랜치
push 자체가 실배포를 트리거한다. 보안 감사가 단독으로 결정할 범위가 아니라고 판단해
운영자 승인 대기로 남긴다.

### 이월 (변동 없음, 운영자 승인 필요)

`production.private` `deploy.yml` 서드파티 액션(`docker/*`, `appleboy/ssh-action`)
SHA 고정 — 브랜치 push 가 실배포를 유발하므로 여전히 승인 대기.

---

## 재검증 로그 — 2026-08-15 (`main` @ `d5f2e31c`)

**결론: `npm audit` 은 전 트리 0건. 이번 지적은 "우리가 발행한 증명을 아무도
읽지 않고 있었다" — 발행 측 provenance 방어의 소비 측 배선 누락이다.**

### 1. 의존성 감사 결과 (변동 없음)

- `main` — **0건** (dep 580: prod 272 / dev 307 / optional 63).
- `production.private` — `main` 과의 차이가 `.github/workflows/deploy.yml`(197줄
  추가) **하나뿐**. 2026-08-13 에 남겨뒀던 보안 통제 3종 드리프트는 그 뒤
  머지(`4577d0f7`)로 해소됐다. `package.json` · 락파일 · `Dockerfile` 전부 동일하므로
  별도 추출 감사 불필요 — 이번 감사 결과가 그대로 배포 브랜치에 적용된다.
- `awb-agent-manager` 단독 트리 (135 deps) — **0건**.
- **카나리 확인**: 임시 트리 `lodash@4.17.4` → critical 1건 정상 보고. "0건" 이
  감사 경로 무응답이 아님을 증명.
- 락파일 위생: 581 항목 전부 `registry.npmjs.org` https + integrity 보유,
  비-레지스트리 resolve 0건. 설치 스크립트는 허용 목록(`@scarf/scarf` · `esbuild` ·
  `fsevents`) 그대로. deprecated 는 typeorm 하위 `glob` 뿐 — 어드바이저리 없음.
- 발행 provenance 유지: `awb-agent-manager@1.6.115` 가 `attestations.provenance`
  (SLSA v1) 보유.
- 버전 지연 중 조치 대상 없음: `turbo` 2.10.9→2.10.10 (dev 전용, 어드바이저리
  없음 — 락파일 재생성이 실 NAS 재배포를 유발하므로 계속 미조치),
  `react` 18.3 / `typeorm` 0.3 메이저 지연은 기존 판단 유지.
- 컨테이너 베이스 이미지: `node:22-slim`, `postgres:16-alpine` — 플로팅 태그라
  재빌드 때마다 배포판 보안 패치를 받는다. 의도된 상태로 유지.

### 2. 이번 조치 — npm-global self-update 의 SLSA provenance 게이트 (fail-closed)

2026-08-10 감사가 발행 측에 `--provenance` 를 붙여 tarball 마다 Sigstore SLSA
증명을 남기게 했다. 그런데 **소비 측이 그 증명을 한 번도 읽지 않았다.**
`apps/agent-manager/src/lib/self-update.ts` 의 npm-global 경로는
`npm install -g awb-agent-manager@latest` 를 그대로 실행하고 매니저를 재시작한다 —
받은 tarball 이 우리 CI 에서 나온 것인지 묻지 않는다.

공격 경로: publish 워크플로의 `NPM_TOKEN`(Automation, 2FA bypass)이 유출되면
공격자가 같은 이름으로 임의 tarball 을 올릴 수 있고, 그것이 self-update 를 타고
매니저 호스트 전체에서 실행된다. 즉 **증명은 만들어졌지만 방어로 쓰이지 않았다.**

게이트가 실효를 갖는 근거: provenance 증명은 GitHub Actions 의 OIDC 토큰으로
Sigstore 에 서명해야만 생성된다. 유출된 npm 토큰만 쥔 공격자는 tarball 은 올려도
증명은 위조할 수 없다. 따라서 "증명 없는 버전은 설치하지 않는다" 한 줄이 그
시나리오를 통째로 막는다.

구현:

1. `npm view awb-agent-manager@latest version dist.attestations --json` 으로 최신
   버전과 그 버전의 증명을 함께 읽고, `parseProvenanceView()` 가 판정한다
   (`predicateType` 이 `https://slsa.dev/provenance/` 로 시작 + 증명 번들이 https).
2. **fail-closed**: 조회 실패 · 파싱 실패 · 증명 없음 · 위조된 predicate — 전부
   설치 거부. 애매한 오류에 강행하는 fail-open 은 publish 워크플로의
   `probe-exists` 단계에서 이미 한 번 막은 실수라 반복하지 않는다. 거부의 결과는
   "업데이트가 안 된다"일 뿐 매니저는 계속 돌아가므로 안전한 실패 방향이다.
3. **TOCTOU 차단**: `@latest` 를 검증한 뒤 다시 `@latest` 로 설치하면 그 사이 태그가
   옮겨간 tarball 이 들어온다. 검증된 **정확한 버전**으로 설치 spec 을 고정했고
   (`awb-agent-manager@1.6.115` 형태), POSIX 즉시 설치 경로와 Windows 분리 헬퍼
   경로 **양쪽 모두**에 같은 pinned spec 을 넘긴다.
4. 복구용 탈출구는 `AWB_SELF_UPDATE_ALLOW_UNVERIFIED=1` 명시적 opt-in 하나뿐.
5. dry-run(`noReExec`)도 게이트 뒤에 두었다 — 거부될 업데이트를 "would run" 이라고
   보고하면 거짓 보고가 된다.

### 3. 부수 조치 — 발행 표면 최소화

루트 `package.json` 은 `private: true` 지만 `apps/server`(`server`) ·
`apps/client`(`client`) 워크스페이스에는 아무 표시가 없었다. `npm publish
--workspaces` 한 번, 혹은 워크스페이스 안에서 무심코 친 `npm publish` 한 번이면
발행 의도가 없는 두 패키지가 공개 레지스트리로 나간다 — 둘 다 `files` 필드도
없어 tarball 은 디렉터리 전체가 된다. 두 곳에 `"private": true` 를 추가해 npm 이
publish 를 하드 거부하게 했다. 락파일은 워크스페이스의 `private` 를 기록하지
않으므로 lockfile 드리프트 없음(`npm ci` 정상).

### 4. 가드 (기계 강제)

- **신규** `apps/agent-manager/test/self-update-provenance-gate.test.mjs` (10 테스트).
  공격자가 만들 수 있는 응답 모양을 직접 먹인다 — 증명 없음 / provenance 없음 /
  위조된 `predicateType` / 비-https 번들 / JSON 아님 / 버전 위조. 배선 확인
  (검증 호출 · fail-closed · pinned spec · Windows 헬퍼) 포함. agent-manager 의
  `test` 스크립트는 `test/*.test.mjs` 글롭이라 CI(양 OS)가 자동으로 집는다.
- `apps/server/test/supply-chain-integrity-guard.test.mjs` **12 → 15**: 발행 가능한
  워크스페이스가 정확히 하나일 것, 그 tarball 이 `files: ["dist"]` 로 좁혀질 것,
  self-update 가 provenance 를 검증할 것.
- **가드가 실제로 무는지 확인**: 설치 spec 을 `@latest` 로 되돌려 재빌드 →
  배선 테스트 1건만 실패(나머지 9건 통과), 원복 후 10/10 통과.
- 회귀 없음: agent-manager 전체 스위트 **950 테스트 (948 pass / 0 fail / 2 skip)**,
  `supply-chain-integrity-guard` 15/15, `react-router-rsc-guard` 6/6, `tsc` 0 에러.

### 5. 이월 (변동 없음, 운영자 승인 필요)

`production.private` `deploy.yml` 서드파티 액션(`docker/*`, `appleboy/ssh-action`)
SHA 고정 — 브랜치 push 가 실배포를 유발하므로 여전히 승인 대기.

---

## 재검증 로그 — 2026-08-16 (`main` @ `40a131be`)

### 결론

`npm audit` 은 `main` / 발행 패키지 / 매니저 트리 전부 **0건**. 이번 발견은
advisory 가 아니라 **설치 경로**에 있었다 — git 체크아웃으로 도는 에이전트
매니저의 self-update 가 저장소 루트에서 bare `npm install` 을 돌려,
**감사한 lockfile 트리 == 매니저가 실제로 실행하는 트리** 가 성립하지 않았다.
`npm ci` 로 교체 + fail-closed + 회귀 가드로 조치 완료.

### 1. 의존성 감사 결과 (변동 없음)

| 대상 | 결과 |
| --- | --- |
| `main` (`npm audit`) | **0 vulnerabilities** (prod 272 / dev 307 / opt 63, total 580) |
| advisory 경로 카나리 (`lodash@4.17.4`) | **1 critical** — 레지스트리 advisory 조회 정상 (0건이 침묵 실패가 아님을 증명) |
| 발행 패키지 격리 트리 (`awb-agent-manager@latest`) | **0 vulnerabilities** |
| lockfile 위생 | 581 엔트리 — 비-npmjs resolve 0, integrity 누락 0, install script 5개 전부 허용목록(`@scarf/scarf`/`esbuild`/`fsevents`×3) 내 |
| provenance | `awb-agent-manager@1.6.116` 에 SLSA v1 `dist.attestations` 생존 |
| `production.private` | `package.json` / `package-lock.json` **완전 동일** (`git diff` 에 lockfile 없음). 차이는 `deploy.yml`(prod 전용) + 2026-08-15 조치(self-update provenance 게이트 · 워크스페이스 `private` · 문서)뿐 — 런타임 아티팩트 영향 없음 |
| 버전 지연 | 유일한 in-range 지연은 `turbo` 2.10.9→2.10.10 (dev 전용, advisory 없음). 락파일 재생성은 prod 재동기화(=실배포)를 강제하므로 기존 판단대로 **미조치** |

`react-router` 는 7.18.2 유지(버전 바닥 가드 통과), `overrides` 핀(`multer`
2.2.0 / `picomatch` ^4.0.4 / `js-yaml` ^5.2.3 / `@hono/node-server` ^2.0.10) 전부
advisory 없는 범위.

### 2. 발견 — git-checkout self-update 가 lockfile 을 우회했다

`apps/agent-manager/src/lib/self-update.ts` 의 git 모드 경로:

```
git fetch → origin/<branch> detached checkout → npm install → npm run build → 재실행
```

`npm install` 은 lockfile 을 **제안**으로만 취급한다. 모든 `^`/`~` 범위를 그 시점
레지스트리에 대고 다시 해결하고, 체크아웃의 `package-lock.json` 자체를 덮어쓴다.
따라서:

- CI 가 `npm ci` 로 검증하고 `npm audit` 이 0으로 승인한 트리가, self-update 후
  매니저가 올라탈 트리와 같다는 보장이 **없었다**.
- 방금 발행된 in-range 악성 패치 버전(전이 의존성 포함, 580개 중 아무거나)이
  조용히 들어온다. 그 트리는 **운영자 자격증명으로 에이전트 CLI 를 띄우는
  호스트**에서 돌고, install script 도 같이 실행된다.
- npm-global 경로는 2026-08-15 provenance 게이트가 막았지만 **git 경로는 그 게이트를
  타지 않는다** — 이쪽의 유일한 방어가 lockfile 강제였고, 그게 없었다.

이건 2026-08-09 감사가 Dockerfile runner 스테이지에서 고친 것과 **같은 결함**이다
(`RUN npm install --omit=dev` → `npm ci`). 그때 배포 이미지는 굳혔지만, 플릿의
git-checkout 매니저를 갱신하는 이 경로만 남아 있었다. 패턴 재확인: **어떤 방어를
세웠으면, 같은 명제를 깨는 다른 설치 경로가 남아 있는지 전부 훑을 것.**

### 3. 조치

`['install']` → `['ci']` (저장소 루트에서 실행하는 이유는 그대로 — monorepo 에서
`-w apps/agent-manager` 는 hoist 된 devDeps 를 항상 다시 깔지 않는다).

- **fail-closed**: `npm ci` 실패 시 예전 버전으로 계속 도는 쪽을 택한다. 검증되지
  않은 트리로 빌드/재실행까지 진행하지 않는다.
- **전제 성립**: `npm ci` 는 lockfile↔`package.json` 불일치에서 실패하는데, 바로
  앞 `adoptRemoteBranch()` 가 `origin/<branch>` 를 통째로 detached 체크아웃하므로
  둘은 같은 커밋에서 나온 짝이다. 더티 트리는 그 앞 단계가 auto-stash 한다.
- **알려진 부작용**: `npm ci` 는 `node_modules` 를 지우고 새로 깐다 — 설치 중에는
  이 체크아웃의 `node_modules` 를 symlink 로 공유하는 워크트리도 잠시 비어 보인다.
  self-update 는 어차피 매니저 재실행으로 끝나므로 그 중단 구간은 이미 전제되어 있다.
- 관리자 UI 문구(`AgentManagerPage.tsx`)의 "git pull + npm install + build" 도
  실제 동작에 맞춰 `npm ci` 로 정정.

### 4. 가드 (기계 강제)

`apps/server/test/supply-chain-integrity-guard.test.mjs` **15 → 16**: git-checkout
self-update 가 `npm ci` 로만 설치하고(로컬 설치용 `['install']` spawn 금지 — 주석
속 언급이나 provenance 게이트가 붙은 `npm install -g` 는 별개), 설치 자체는 여전히
존재하며(가드가 죽은 채 초록불 내는 것 방지), 실패 시 fail-closed 인지 확인.

- **가드가 실제로 무는지 확인**: `['ci']` 를 `['install']` 로 되돌리면 새 테스트
  1건만 정확히 실패, 원복 후 16/16 통과.
- 회귀 없음: agent-manager 전체 스위트 **950 테스트 (948 pass / 0 fail / 2 skip)**,
  `supply-chain-integrity-guard` 16/16, `react-router-rsc-guard` 6/6,
  agent-manager `tsc` 빌드 통과, client `tsc` 0 에러.

### 5. 이월 (변동 없음, 운영자 승인 필요)

`production.private` `deploy.yml` 서드파티 액션(`docker/*`, `appleboy/ssh-action`)
SHA 고정 — 브랜치 push 가 실배포를 유발하므로 여전히 승인 대기.

---

## 재검증 로그 — 2026-08-17 (`main` @ `df4c5961`)

의존성은 여전히 깨끗했고, 발견은 **fs-browser 스코프의 fail-open** 이었다.

### 1. 정기 점검 (모두 통과, 변동 없음)

| 항목 | 결과 |
| --- | --- |
| `npm audit` (main) | **0 vulnerabilities** (prod 272 / dev 307 / opt 63, total 580) |
| 카나리아 (`lodash@4.17.4`) | 1 critical 검출 — 어드바이저리 경로 살아있음 확인 |
| lockfile 위생 | 581 엔트리, 비-npmjs 0 (워크스페이스 link 3건 제외), integrity 누락 0, install script 5건 전부 allowlist |
| publish provenance | `awb-agent-manager@1.6.117` SLSA v1 증명 유지 |
| `production.private` | `package.json`/`package-lock.json`/`Dockerfile` **바이트 동일** — 런타임 드리프트 없음 |
| 기존 가드 | supply-chain 16/16, react-router 6/6 |

`main` 이 전날 감사 커밋(`df4c5961`)에서 전진하지 않았으므로 새 의존성 발견은
기대할 수 없었다. 그래서 **이전 감사들이 건드리지 않은 표면**을 골라 들어갔다 —
AWB 서버가 SSE `fs_request` 로 구동하는 reverse-RPC, 즉 매니저 호스트의 파일시스템.

### 2. 발견 — 운영자가 지정한 스코프가 조용히 증발하는 두 경로

`fs_browser.roots` 미설정 시 호스트 전체 브라우징은 ST-7 의 **의도된 기본값**이라
그대로 둔다. 문제는 운영자가 roots 를 **명시했는데도** 그 정책이 사라지던 두 지점이다.

1. **`fs-browser.ts` `resolveRootsSync()` — 설정한 roots 가 하나도 realpath 되지
   않으면 "falling back to unrestricted browsing".** 마운트 해제, 디렉터리 개명,
   아직 생성 전인 경로 같은 *일시적* 사유로 confinement 가 통째로 풀린다. 스코프
   판정이 `this.roots.length > 0 && !inScope(...)` 라서 "해결된 root 0개" 가
   "스코프 설정 없음 = 전부 허용" 으로 읽혔다. 이 상태에서 열리는 것:
   `~/.ssh/id_*`, `~/.npmrc`(NPM_TOKEN), `~/.config/awb-agent-manager/config.json`
   (매니저의 AWB 자격증명) — 즉 이전 감사들이 쌓아온 공급망 방어의 **열쇠**들이다.
2. **`event-dispatcher.ts` lazy-construct 폴백이 `new FsBrowser(this.#config, null)`.**
   main.ts 배선이 빠진 순간 설정된 roots 를 통째로 버리고 무제한으로 뜬다.
   `fs_browser` 가 `AwbConfig` 에 타입으로 없고 `(config as any)` 로만 읽히는 탓에
   이 `null` 이 타입 검사에 걸리지 않았다.

### 3. 조치 — fail-closed + 자동 복구

- 스코프 판정을 `roots.length` 가 아니라 **`hasExplicitRoots`** 기준으로 변경.
  운영자가 좁히겠다고 선언했으면, 좁히지 못할 때는 **아무것도 내주지 않는다.**
- 거부는 `realpath` **이전**에 수행 — 스코프 불능 상태에서 ENOENT/성공 차이로
  스코프 밖 경로의 존재 여부가 새는 것까지 막는다.
- fail-closed 의 대가(일시 장애 시 picker 영구 정지)는 **요청마다 재해결**
  (`ensureRootsResolved()`)로 상쇄 — 마운트가 돌아오면 스스로 복구된다.
- `roots` op 이 스코프 불능일 때 `$HOME`/cwd 를 광고하던 것도 제거 (빈 목록 반환).
  운영자가 일부러 배제한 지점을 picker 시작점으로 건네주면 안 된다.
- dispatcher 폴백이 `(this.#config as any)?.fs_browser` 를 넘기도록 수정.

### 4. 가드 (기계 강제)

신규 `apps/agent-manager/test/fs-browser-scope.test.mjs` **10건** — 이 표면은
그동안 테스트가 **0건**이었다. 동작 8건(in/out-of-scope, 미해결 스코프 전면 거부,
빈 roots 광고, 자동 복구, symlink 탈출, mkdir name traversal, 기본값 무제한 유지,
상대경로 거부) + 소스 가드 2건(무제한 폴백 부활 금지, dispatcher 폴백의 roots 보존).

- **가드가 실제로 무는지 확인**: 수정 원복 시 정확히 **5건 실패**(그중
  "미해결 스코프 전면 거부" 는 스코프 밖 비밀 파일 읽기가 `ok:true` 로 성공 —
  취약점이 실재했음을 증명), 복원 후 10/10 통과.
- 회귀 없음: agent-manager 전체 스위트 **960 테스트 (958 pass / 0 fail / 2 skip)**,
  supply-chain 16/16, react-router 6/6.

### 5. 이월 (변동 없음, 운영자 승인 필요)

`production.private` `deploy.yml` 서드파티 액션 SHA 고정 — 브랜치 push 가 실배포를
유발하므로 여전히 승인 대기. 이번 변경은 agent-manager 전용이라 webapp 런타임
영향이 없어 `production.private` 병합은 하지 않았다.

---

## 재검증 로그 — 2026-08-21 (`main` @ `baa7a156`)

의존성 자체는 깨끗했다. 이번 발견은 **감사의 시간축** 이다 — 지금까지 쌓아온
게이트가 전부 *이벤트 구동* 이라, 우리가 코드를 건드리지 않는 기간은 아무도
보지 않는 구간이었다.

### 1. 정기 점검 (모두 통과, 변동 없음)

| 항목 | 결과 |
| --- | --- |
| `npm audit` (main) | **0 vulnerabilities** (prod 272 / dev 307 / opt 63, total 580) |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| 카나리아 (`lodash@4.17.15` + `minimist@1.2.0`) | 1 critical + 1 high 검출 — 어드바이저리 경로 살아있음 확인 |
| lockfile 위생 | 581 엔트리, 비-registry resolved **0**, 평문 http **0**, integrity 누락 **0** |
| install script | 3건 (`esbuild`/`fsevents`/`@scarf/scarf`) 전부 allowlist 내 |
| 액션 SHA 고정 | `uses:` 14건 전부 커밋 SHA |
| 메이저 뒤처짐 | `npm outdated` 24건 중 **메이저 뒤처짐 0건** (react 18→19, typeorm 0.3→1.1 은 기능 업그레이드로 보안 무관) |
| `production.private` | `package.json`/`package-lock.json`/`Dockerfile` **바이트 동일** — 런타임 드리프트 없음 |
| 기존 가드 | supply-chain 16/16, react-router 6/6, ci-branch-coverage 6/6 |

**배포 아티팩트 관점 추가 점검** — 호스트는 `npm i -g awb-agent-manager` 로
설치하므로, 실제 깔리는 트리는 **우리 lockfile 이 아니라** `^` 범위의 최신 재해결
결과다. 그 트리를 따로 감사했다: `awb-agent-manager@1.6.127` (97 패키지) **0건**.
다만 둘은 실제로 갈린다 — `smol-toml` 은 lockfile 1.7.1 / 신규 설치 1.8.0. 오늘은
양쪽 다 깨끗하지만, 이 차이는 "CI 초록 ≠ 호스트 안전" 이 될 수 있는 지점이므로
기록해 둔다.

### 2. 이월 항목 해소 확인 — `deploy.yml` 액션 SHA 고정

2026-08-16 이후 "운영자 승인 대기" 로 이월돼 있던 항목이다. `origin/production.private`
의 `deploy.yml` 을 직접 확인한 결과 서드파티 액션 5건(`actions/checkout`,
`docker/setup-buildx-action`, `docker/login-action`, `docker/build-push-action`,
`appleboy/ssh-action`)이 **전부 커밋 SHA 로 고정돼 있다** — 해소됐다.

회귀 방어도 이미 붙어 있다: `deploy.yml` 은 `production.private` 에만 있는 파일이고,
2026-08-20 감사가 그 브랜치를 `ci.yml` push 트리거에 넣었으므로, 그 브랜치에서 도는
`audit-action-pins.mjs` 가 `.github/workflows/` 전체를 훑으며 `deploy.yml` 도 함께
검사한다.

### 3. 발견 — 의존성 감사에 시간축이 없었다

`ci.yml` 의 트리거는 `pull_request` / `push(main, production.private)` /
`workflow_dispatch` — **전부 이벤트 구동**이다. 그런데 `npm audit` 이 판정하는 건
"우리 lockfile 이 바뀌었는가" 가 아니라 **"이 버전에 대해 advisory 가 새로 나왔는가"**
이고, 그 둘은 완전히 독립적이다. 의존성을 한 줄도 건드리지 않아도 어제까지 깨끗하던
버전에 오늘 CVE 가 붙는다.

즉 이벤트 구동만으로는 **"누군가 의존성을 건드리는 다음 push"** 까지 새 advisory 를
아무도 평가하지 않는다. 이 저장소에서 lockfile 이 몇 주씩 그대로인 구간이 실제로
있었고, 그 사이에도 배포는 계속 나갔다. 지금까지 그 공백을 메운 것은 사람/에이전트가
생각날 때 돌리는 수동 감사뿐이었다 — 즉 이 문서 자체가 그 우회로였다.

두 번째 층: GitHub 의 `schedule` 트리거는 **기본 브랜치에서만** 돈다. cron 을 그냥
달면 `main` 의 lockfile 만 매일 보게 되는데, 정작 NAS 에서 돌고 있는 트리는
`production.private` 이고 그쪽은 여전히 push 때만 감사된다.

### 4. 조치

- **`ci.yml` 에 `schedule: - cron: '17 4 * * *'`**(13:17 KST) 추가 — 매일
  `dependency-audit` 만 돈다.
- **무거운 잡 5개**(`chat-join-grep-guard`, `agent-manager-tests`, `client-tests`,
  `server-tests`, `postgres-dialect-matrix`)에 `github.event_name != 'schedule'`
  추가 — 같은 커밋이 이미 push 에서 전체 매트릭스를 통과했으므로 매일 다시 태우지
  않는다. cron 이 태우는 건 `npm ci` 조차 하지 않는 수 초짜리 감사 잡 하나뿐이다.
- **`scripts/audit-deploy-branch-deps.mjs` 신규** (schedule 전용 스텝) — 배포 브랜치의
  `package.json`/`package-lock.json` 만 꺼내 격리된 임시 디렉터리에서 `npm audit`.
  `npm ci` 를 하지 않아 "취약점을 찾는 잡이 그 취약점의 install script 를 먼저
  실행하는" 순서 문제가 없다. lockfile 이 현재 브랜치와 바이트 동일하면 '동일함을
  증명하고 스킵'. fetch 실패·lockfile 판독 실패는 **fail-closed** — "확인 못 했다"
  를 "문제 없다" 로 바꿔 읽는 게 이 계열 가드의 가장 위험한 실패 모드다.
- `audit-ci-branch-coverage.mjs` 에서 `deployBranches()` / `KNOWN_DEPLOY_BRANCHES`
  를 export — 두 가드가 **같은 배포 브랜치 목록**을 보게 해 불변식이 갈라지지 않게 했다.

### 5. 가드 (기계 강제)

**`scripts/audit-cron-coverage.mjs` 신규** — `dependency-audit` 스텝으로 편입.
두 가지를 강제한다: (1) `schedule:` 트리거가 살아 있는가, (2) `dependency-audit`
을 뺀 모든 잡이 `github.event_name != 'schedule'` 로 스킵되는가.

(2)를 굳이 가드하는 이유: 조건이 잡마다 반복되는 형태라 새 잡을 추가하는 사람이
빠뜨리기 쉽고, **빠뜨려도 CI 는 초록이라 아무도 모른다** — 비용/노이즈로만 새는
침묵형 회귀다. 여기서 FAIL 시켜 "이 잡을 cron 에서 돌릴 것인가" 를 명시적 결정으로
만든다(의도된 경우 `CRON_ONLY_JOBS` 에 추가).

**`apps/server/test/cron-coverage-guard.test.mjs` 신규 6건** — 가드 자신의 파서를
단언한다. `jobConditions()` 가 잡을 하나도 못 읽으면 검사 대상이 없어 **조용히
통과**하기 때문이다(그래서 main() 에도 "잡 0개면 FAIL" 을 뒀다).

**가드가 실제로 무는지 확인**:
- `schedule:` 블록 제거 + 잡 하나의 스킵 조건 제거 → `audit-cron-coverage.mjs`
  가 정확히 그 2건을 짚고 `exit 1`. 원복 후 통과.
- `audit-deploy-branch-deps.mjs` 의 **실제 감사 경로 실행 확인**: 로컬 lockfile 을
  1바이트 바꿔 '동일 스킵' 을 무력화 → `production.private` lockfile 을 꺼내
  진짜 `npm audit` 실행, 통과 보고. (`npm audit --audit-level=moderate` 는
  취약 트리에서 exit 1 이며 카나리아로 확인 → `execFileSync` 가 throw 하는 FAIL
  경로가 실배선돼 있다.)
- 워크플로 YAML 파싱 검증: `ci.yml` / `publish-agent-manager.yml` 둘 다
  `js-yaml` 로 로드 성공, 트리거 4종(`pull_request`/`push`/`schedule`/
  `workflow_dispatch`)·잡 6개·조건 5개 확인.
- 로컬 회귀 확인: supply-chain 16/16, ci-branch-coverage 6/6, cron-coverage 6/6,
  react-router 6/6, 기존 가드 스크립트 5개 전부 PASS.
- **CI 전체 확인(그리고 로컬만으로는 못 잡은 것 하나)**: 첫 푸시(`4ee954c7`)에서
  `apps/server full test suite` 가 red 였다 — `test-registration-completeness`
  가드가 신규 `cron-coverage-guard.test.mjs` 를 "package.json `test` 스크립트에
  없어 `npm test` 가 조용히 건너뛰는 고아 테스트"(ticket 0b4f089d 버그 계열)로
  잡았다. 관련 가드만 골라 돌린 로컬 실행으로는 드러나지 않는 종류다. `686ccd56`
  에서 등록해 해소했고, 그 커밋의 CI 는 **7개 잡 전부 success**.
- `dependency-audit` 잡 스텝 실측(`686ccd56`): npm audit / install-script /
  액션 SHA / 배포 브랜치 커버리지 / **정기 감사 커버리지** 전부 success,
  **배포 브랜치 lockfile 재감사는 skipped** — push 이벤트에서 의도대로 건너뛴다.

### 6. 이월

없음 — 2026-08-16 부터 이월돼 온 `deploy.yml` SHA 고정 건이 위 2절에서 해소됐다.

## 재검증 로그 — 2026-08-22 (`main` @ `e0235425`)

### 결론

의존성 자체는 또 깨끗했다 — `main`, 배포 브랜치, 발행 트리 전부 0건. 이번 발견은
**감사 대상의 정체성**이다: 지금까지 모든 게이트가 `package-lock.json` 을 봐 왔는데,
라이브 호스트가 실제로 돌리는 트리는 그 lockfile 이 아니다. 2026-08-21 감사가
`smol-toml` 1건으로 관측하고 "기록해 둔다"로 넘긴 항목인데, 오늘 측정해 보니
**10개 패키지**였고 그중 하나는 메이저까지 갈려 있었다.

### 1. 정기 점검 (모두 통과, 변동 없음)

| 항목 | 결과 |
| --- | --- |
| `npm audit` (main) | **0 vulnerabilities** (prod 272 / dev 307 / opt 63, total 580) |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| 카나리아 (`lodash@4.17.15` + `minimist@1.2.0`) | 1 critical + 1 high 검출 — 어드바이저리 경로 살아있음 확인 |
| lockfile 위생 | 581 엔트리, 비-registry resolved **0**, 평문 http **0**, integrity 누락 **0** |
| install script | 3건 (`esbuild`/`fsevents`/`@scarf/scarf`) 전부 allowlist 내 |
| 액션 SHA 고정 | `uses:` 14건 전부 커밋 SHA |
| `production.private` | `package.json`/`package-lock.json`/`Dockerfile`/`turbo.json` **바이트 동일** — 의존성 드리프트 없음 |
| 기존 가드 | supply-chain 16/16, ci-branch-coverage 6/6, cron-coverage 6/6 (총 28/28) |

**배포 브랜치 드리프트 실측** — `origin/main` ↔ `origin/production.private` 는 61개
파일이 갈려 있지만, 의존성 축은 전부 동일하다. 갈린 것 중 매니페스트는
`apps/server/package.json` / `apps/client/package.json` 2개뿐이고, 그 diff 는 **전부
`test` / `posttest` 스크립트의 테스트 목록** — prod 가 main 보다 뒤처져 있어 신규
테스트가 아직 안 들어간 것이다. `dependencies` 블록은 양쪽 동일. 즉 이번에도 런타임
드리프트는 없다.

**메이저 뒤처짐** — `undici` 가 7.29.0 인데 상류 최신은 8.10.0 이다(8.0.0 은 2026-04-02).
다만 7.29.0 은 **7.x 최신이고 2026-07-24 에 나왔다**(8.9.0 과 같은 날) — 7 계열이
아직 유지보수 중이라는 뜻이라 보안 사유의 강제 업그레이드 대상은 아니다. 기존
이월(react 18→19, typeorm 0.3→1.1)과 같은 성격으로 둔다.

### 2. 발견 — 우리는 호스트가 돌리지 않는 트리를 감사해 왔다

`agent-manager` 는 라이브 호스트에 `npm i -g awb-agent-manager` 로 설치된다.
**그 경로는 우리 `package-lock.json` 을 읽지 않는다** — npm 이 발행 패키지의
`^` 범위를 그 시점 레지스트리에서 새로 해석한다. 그래서 CI 가 판정한 트리와
호스트가 돌리는 트리는 애초에 다른 객체다.

실패 모드가 조용하다:

> `^` 로만 닿는 버전에 advisory 가 붙는다 → lockfile 은 그 버전을 가리키지 않으므로
> `npm audit` 은 계속 0건 → **CI 는 영원히 초록인데 모든 라이브 호스트는 취약하다.**

기존 게이트 중 어느 것도 이 축을 보지 않는다. lockfile 감사(main)·배포 브랜치
lockfile 재감사·install-script 허용목록·액션 SHA 고정은 전부 lockfile 축이거나
워크플로 축이다. 발행 워크플로(`publish-agent-manager.yml`)도 `npm ci`(=lockfile)로
빌드할 뿐, **소비자가 무엇을 해석하게 될지는 보지 않는다.**

2026-08-21 감사가 이 지점을 `smol-toml` 1건(lockfile 1.7.1 / 신규 설치 1.8.0)으로
관측하고 "CI 초록 ≠ 호스트 안전이 될 수 있는 지점" 이라 적어 뒀지만 가드는 붙이지
않았다. 오늘 실제로 해석해서 세어 보니 **10건**이다:

| 패키지 | lockfile | 호스트가 받는 버전 |
| --- | --- | --- |
| `type-is` | 1.6.18 | **2.1.0** (메이저 차이) |
| `ip-address` | 10.4.0 | 10.5.0 |
| `jose` | 6.2.8 | 6.2.10 |
| `hono` | 4.13.0 | 4.13.3 |
| `@hono/node-server` | 2.1.0 | 2.1.1 |
| `ajv` | 8.18.0 | 8.20.0 |
| `smol-toml` | 1.7.1 | 1.8.0 |
| `content-type` | 2.0.0 | 2.1.0 |
| `eventsource-parser` | 3.1.0 | 3.1.1 |
| `negotiator` | 1.0.0 | 1.1.0 |

목록의 성격이 문제다 — `ip-address`(과거 SSRF advisory 3건으로 이 문서 첫 절에서
올린 바로 그 패키지), `jose`(JWT 검증), `hono`/`@hono/node-server`(과거
GHSA-frvp-7c67-39w9 로 root override 를 건 패키지), `ajv`. 하필 이 저장소가
지금까지 취약점을 실제로 맞았던 패키지들이 그대로 드리프트 목록에 있다.
**오늘 기준 이 10개 버전은 전부 깨끗하지만, 어떤 게이트도 그걸 확인한 적이 없었다** —
오늘 이 감사가 처음이다.

### 3. 조치 — `scripts/audit-published-deps.mjs` 신규

lockfile 이 아니라 **해석 결과**를 감사한다. 두 질문을 분리해서 각각 답한다:

- **live** — 지금 `npm i -g awb-agent-manager` 하면 뭐가 깔리는가. 레지스트리
  `latest` 를 그대로 해석 → **지금 이 순간 호스트에 떠 있는 트리**(93 패키지).
- **next** — 워크스페이스 매니페스트의 선언 범위는 뭘로 해석되는가 →
  **다음 publish 가 호스트에 넘길 트리**(92 패키지).

둘은 갈릴 수 있다. `latest` 는 과거 커밋에서 발행됐으므로 그때의 범위를 들고 있고
워크스페이스는 지금의 범위를 들고 있다 — "오늘 호스트가 안전한가" 와 "다음 배포가
안전한가" 는 다른 질문이라 둘 다 답해야 한다. (오늘은 양쪽 범위가 동일했다.)

설계는 기존 감사 스크립트 규약을 따랐다:

- **설치하지 않는다.** `npm install --package-lock-only --ignore-scripts` 로 해석만
  하고 그 lockfile 에 `npm audit`. "취약점을 찾는 잡이 그 취약점의 install script 를
  먼저 실행하는" 순서 문제가 원천적으로 사라진다.
- **fail-closed.** 네트워크·해석·audit 어느 단계가 실패해도 통과시키지 않는다.
- **드리프트를 침묵시키지 않는다.** 통과하더라도 위 표를 매 실행 로그에 남긴다.
  "오늘은 둘 다 깨끗" 이 조용히 지나가면 다음 사람이 이 구멍의 존재를 모른다 —
  실제로 2026-08-21 에 그렇게 지나갔다.

### 4. 배선 — 싼 층은 항상, 비싼 층은 cron

전체 모드는 레지스트리를 때리므로 매 PR 마다 돌리면 CI 가 비-hermetic 해지고
레지스트리 blip 이 곧 red 다. 그래서 `schedule` 전용으로 뒀다(배포 브랜치 lockfile
재감사와 같은 층). 그런데 그렇게만 두면 **범위를 넓히는 PR**(`^1.7.0` → `*`)이 최대
24시간 방치된다 — 범위 확장은 이 구멍의 폭을 직접 키우는 변경이라 PR 시점에 막아야
하고, 그 판정은 순수 문자열이라 오프라인으로 가능하다.

그래서 두 스텝으로 나눴다:

| 스텝 | 트리거 | 하는 일 |
| --- | --- | --- |
| `발행 패키지 선언 범위 가드` (`--offline`) | **항상** | 선언 범위에 상한이 있는가. `*`/`x`/`""`/`latest`/`>=` 단독/비-레지스트리 스펙(`git:`/`file:`/`https:`) 거부 |
| `발행 트리 재감사` | `schedule` | live·next 양쪽 실제 해석 + `npm audit` + 드리프트 리포트 |

상한이 없으면 업스트림의 임의 메이저가 우리 승인 없이 호스트에 들어올 수 있고,
그 트리는 **어떤 lockfile 게이트에도 잡히지 않는다** — 이 감사의 발견 그 자체다.

### 5. 가드 (기계 강제)

**`apps/server/test/published-deps-audit-guard.test.mjs` 신규 10건.**

가드 스크립트 자신의 **판정 로직**을 단언한다. 실패 모드가 비대칭이기 때문이다:

- 네트워크 층(`resolveAndAudit`)이 깨지면 → throw 하고 fail-closed 로 죽는다. 시끄럽다.
- **범위 판정 층(`rangeProblem`)이 느슨해지면 → 조용히 전부 통과한다.** `*` 를
  "상한 있음" 으로 잘못 읽어도 CI 는 초록이고, 그 순간 이 가드는 존재하지만
  아무것도 막지 않는 상태가 된다.

같은 이유로 `main()` 에 **"런타임 의존성 0개면 FAIL"** 을 뒀다 — 매니페스트 구조가
바뀌어 파서가 아무것도 못 읽어도 "검사 대상 0개" 는 통과처럼 보인다(2026-08-21
`jobConditions()` 건과 같은 계열).

마지막 테스트는 **ci.yml 배선 자체**를 단언한다. 스크립트만 있고 호출부가 없으면
가드 전체가 장식이 되는데 그 상태도 CI 는 초록이다.

**가드가 실제로 무는지 확인** (전부 실측):

- 범위 판정 22 케이스 표 검증 — `^1.2.3`/`~1.2.3`/`1.2.3`/`=1.2.3`/`1.x`/`1`/`1.2`/
  `>=1.0.0 <2.0.0`/`1.0.0 - 2.0.0`/`^1.0.0 || ^2.0.0` 통과, `*`/`x`/`X`/`""`/`latest`/
  `>=1.0.0`/`>1.0.0`/`^1.0.0 || >=3`/`github:`/`git+https:`/`file:`/`link:`/`https:` 거부.
- 실제 매니페스트의 `smol-toml` 을 `^1.7.0` → `>=1.7.0` 으로 넓힘 → `--offline` 이
  정확히 그 1건을 짚고 `exit 1`. 원복 후 통과.
- `dependencies` 를 `{}` 로 비움 → "검사 대상 0개" 를 통과로 읽지 않고 `exit 1`.
- 취약 트리 실행 경로 확인 — `resolveAndAudit` 에 `lodash@4.17.15` 를 물림 →
  실제 해석 후 `npm audit` 이 high 검출, throw 하는 FAIL 경로가 실배선돼 있음.
- ci.yml 에서 `--offline` 스텝 제거 → 배선 테스트가 정확히 그 1건으로 red. 원복 후 10/10.
- YAML 파싱 검증: `ci.yml`/`publish-agent-manager.yml` 둘 다 `js-yaml` 로드 성공,
  트리거 4종·잡 6개, `dependency-audit` 스텝 10개(신규 2개 포함, schedule 조건 2건).
- 로컬 회귀: supply-chain / ci-branch-coverage / cron-coverage / react-router
  **28/28 pass**, 감사 스크립트 5개 전부 PASS.
- **`test-registration-completeness` 4/4 pass** — 2026-08-21 에 CI 를 red 로 만든
  "package.json `test` 스크립트에 없는 고아 테스트"(ticket 0b4f089d 계열)를 이번엔
  로컬에서 미리 확인했다. 신규 테스트는 `test` 스크립트의 `cron-coverage-guard`
  바로 뒤에 등록돼 있다(같은 감사 계열 가드끼리 인접).

### 6. 이월 (변동 없음, 운영자 판단 필요)

- `react` 18→19, `typeorm` 0.3→1.1, `@hello-pangea/dnd` 17→18, `undici` 7→8 —
  전부 기능 메이저이고 보안 사유 없음. 현 버전은 각 계열의 최신이며 advisory 0건.

## 재검증 로그 — 2026-08-23 (`main` @ `857d10f4`)

### 결론

의존성 자체는 또 깨끗했다 — `main`, 배포 브랜치, 발행 트리(live/next) 전부 0건.

이번 발견은 **어제 넓힌 감사 대상에서 한 축이 빠져 있었다**는 것이다. 2026-08-22
감사가 "lockfile 이 아니라 호스트가 받는 트리를 봐야 한다" 를 세우고 그 트리에
`npm audit` 을 붙였는데, 그 트리에 대해 물어야 할 질문은 두 개였다. advisory 는
붙였고 **install script 는 빠뜨렸다** — 그런데 둘 중 더 빠르고 더 직접적인 쪽은
후자다. CVE 가 하나도 없어도 서드파티 `postinstall` 하나면 모든 라이브 호스트에서
매니저 권한으로 임의 코드가 돈다.

### 1. 정기 점검 (모두 통과, 변동 없음)

| 항목 | 결과 |
| --- | --- |
| `npm audit` (main) | **0 vulnerabilities** (prod 276 / dev 307 / opt 85, total 606) |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| 카나리아 (`lodash@4.17.15` + `minimist@1.2.0`) | 1 critical + 1 high 검출 — 어드바이저리 경로 살아있음 확인 |
| lockfile 위생 | 606 엔트리, 비-registry resolved **0**, 평문 http **0**, integrity 누락 **0** |
| install script (lockfile 축) | 3건 (`esbuild`/`fsevents`/`@scarf/scarf`) 전부 allowlist 내 |
| 액션 SHA 고정 | `uses:` 14건 전부 커밋 SHA |
| 발행 트리 감사 (live/next) | 96 / 92 패키지, moderate 이상 **0건** |
| `production.private` | `package.json`/`package-lock.json`/`Dockerfile`/`turbo.json`/워크스페이스 매니페스트 3종 **전부 바이트 동일** — 의존성 드리프트 없음 |
| 기존 가드 | supply-chain 16/16, ci-branch-coverage 6/6, cron-coverage 6/6, published-deps 10/10 |

**배포 브랜치 드리프트 실측** — `origin/main` ↔ `origin/production.private` 는 6개
파일만 갈려 있고(`deploy.yml` + CLI 런타임 프로파일 관련 5개) **의존성 축은 전혀
갈리지 않는다**. 어제 갈려 있던 `apps/server/package.json` / `apps/client/package.json`
(테스트 목록 차이)도 그 사이 동기화돼 지금은 바이트 동일이다.

**발행 트리 드리프트** — 어제 10건이었고 오늘 **11건**이다(`fast-uri` 3.1.5 → 3.1.6
추가). 여전히 lockfile 이 가리키지 않는 버전들이고, 여전히 전부 깨끗하다. 이 표를
매 실행 로그에 남기는 이유는 2026-08-22 절에 적은 그대로다.

**메이저 뒤처짐** — 변동 없음. `undici` 7.29.0 은 7.x 최신이고 7 계열이 유지보수
중이므로 보안 사유의 강제 업그레이드 대상이 아니다(2026-08-22 판단 유지).

### 2. 발견 — 해석된 트리를 advisory 로만 봤고, install script 로는 보지 않았다

어제 세운 사실: **`npm i -g awb-agent-manager` 는 우리 lockfile 을 읽지 않는다.**
호스트가 받는 트리는 그 시점 레지스트리에서 `^` 범위를 새로 해석한 별개의 객체다.

그 트리에 대해 물어야 할 질문은 두 개인데 하나만 물었다:

| 축 | 무엇을 묻는가 | lockfile 트리 | **해석된(호스트) 트리** |
| --- | --- | --- | --- |
| advisory | 알려진 취약점이 있는가 | `npm audit` (오래전부터) | `audit-published-deps.mjs` (2026-08-22) |
| **install script** | **설치할 때 무엇이 실행되는가** | `audit-install-scripts.mjs` | **아무것도 없었다** |

`scripts/audit-install-scripts.mjs` 는 정확히 이 축을 허용목록으로 강제한다 —
그런데 첫 줄이 `readFileSync(resolve(root, 'package-lock.json'))` 이다. 즉
**어제 "다른 객체" 라고 확인한 바로 그 파일**을 읽는다. 그래서 CI 러너의 트리는
지켜지고 라이브 호스트의 트리는 지켜지지 않았다.

이 축의 실패 모드가 advisory 보다 나쁜 이유:

> advisory 는 취약점이 **발견되고 공시된 뒤에야** 붙는다. install script 는 그런
> 지연이 없다 — 탈취된 패키지가 퍼지는 데 필요한 건 publish 한 번이고, 그 순간부터
> `npm i -g` 하는 모든 호스트에서 코드가 돈다. CVE 번호는 한참 뒤에 붙거나 안 붙는다.

그리고 실행 경로가 실제로 열려 있었다. `self-update.ts` 의 전역 설치 두 곳
(POSIX 경로 / Windows detached 헬퍼) 모두 `npm install -g <spec>` 을 플래그 없이
실행한다 — npm 기본값은 **lifecycle script 실행**이다. 2026-08-15 에 붙인 SLSA
provenance 게이트는 **우리 tarball 의 출처**를 보증할 뿐, 그 아래 95개 전이
의존성이 설치 시 무엇을 실행하는지에 대해서는 아무 말도 하지 않는다.

**실측** — 오늘 기준 발행 트리(96 패키지)의 install-script 패키지는 **0개**다.
즉 지금 뚫려 있는 건 아니다. 뚫려 있는 것은 **그 0 을 아무도 확인하지 않는다**는
사실이고, 0 이 1 이 되는 데 우리 커밋은 한 줄도 필요 없다.

### 3. 조치 — 탐지(cron)와 차단(실행 시점) 2겹

**(a) 탐지 — `scripts/audit-published-deps.mjs` 에 install-script 축 추가**

이미 해석된 lockfile 을 들고 있으므로 추가 네트워크 비용이 0이다. `npm install
--package-lock-only` 는 설치하지 않지만 packument 에서 `hasInstallScript` 를
lockfile 에 채워 넣는다 — 스크립트를 **실행하지 않고** "진짜로 깔면 무엇이
실행되는가" 를 읽어낼 수 있다(실측 확인: `esbuild@0.25.0` 을 그 모드로 해석하면
`hasInstallScript: true` 가 그대로 들어온다). live/next 양쪽에 대해 판정하고,
통과하더라도 `install script 0개` 를 로그에 남긴다.

허용목록(`PUBLISHED_TREE_INSTALL_SCRIPTS_ALLOWED`)은 **의도적으로 비어 있고,
lockfile 축의 ALLOWED 와 별개 집합이다.** 빌드 체인이 `esbuild` 의 postinstall 을
정당하게 필요로 한다는 사실은 라이브 호스트에서 임의 코드가 도는 것을 정당화하지
않는다. 실측 0개이므로 빈 집합이 희망이 아니라 현재 상태다.

**(b) 차단 — self-update 전역 설치에 `--ignore-scripts`**

탐지만 두면 cron 층이라 최대 24시간 방치된다. 실행 시점에서 막는 층이 따로 필요하다.
`self-update.ts` 의 두 호출부(POSIX / Windows 헬퍼) 모두에 `--ignore-scripts` 를 붙였다.

깨지는 것이 없음을 실측으로 확인했다:

- 격리된 prefix 에 `npm install -g --prefix /tmp/... --ignore-scripts awb-agent-manager@latest`
  → 96 패키지 설치, `bin/awb-agent-manager` 심링크 정상 생성, `--version` 이
  `1.6.148` 출력. **bin 링크는 lifecycle script 가 아니라 npm 코어 동작**이라
  이 플래그의 영향을 받지 않는다.
- 발행 tarball 의 `package.json` 확인 — `preinstall`/`install`/`postinstall` 없음.
  `prepublishOnly` 는 publish 시점에 소스 트리에서만 돌고 소비자 설치와 무관하다.

**(c) 운영자가 손으로 치는 경로도 같이 맞췄다**

부트스트랩(`npm i -g awb-agent-manager`)은 우리가 플래그를 넣을 수 없는 경로다 —
문서에 있는 명령이 곧 그 경로다. `apps/agent-manager/README.md`, `docs/agent-manager.md`,
그리고 Admin UI 가 "수동 업그레이드" 안내로 띄우는 문자열
(`AgentManagerPage.tsx` 3곳)을 `npm i -g --ignore-scripts …` 로 통일했다.
UI 문자열 2개는 자동 업데이트가 **실제로 실행하는 명령**을 설명하는 자리라,
그대로 뒀으면 오늘부로 사실과 다른 안내가 된다.

### 4. 가드 (기계 강제)

`apps/server/test/published-deps-audit-guard.test.mjs` 에 **6건 추가** (10 → 16).
새 파일을 만들지 않았으므로 `package.json` `test` 등록은 이미 돼 있다(2026-08-21
고아 테스트 계열 회귀 없음 — `test-registration-completeness` 4/4 확인).

- `installScriptPackages()` 파싱 — 중첩 경로/스코프 이름 추출, `link` 엔트리 제외.
- `hasInstallScript` 없는 트리를 **0개로 읽는가** (거짓 양성 없음).
- `disallowedInstallScripts()` 가 허용목록을 **이름 정확 매칭**으로만 빼는가.
- 허용목록이 **지금 비어 있는가** — 항목이 생기면 여기서 멈춰 세운다.
- **self-update 의 전역 설치 호출부가 전부 `--ignore-scripts` 를 쓰는가.**
  호출부를 하나도 못 찾으면 "검사 대상 0개" 로 조용히 통과하므로 `>= 2` 를 함께 단언한다.
- **결합 강제** — 허용목록이 비어 있지 않은데 `--ignore-scripts` 가 남아 있으면 FAIL.
  두 결정은 반대 방향으로 묶여 있다: 허용목록에 이름을 넣는다는 건 "이 패키지는
  install script 가 필요하다" 는 뜻인데 `--ignore-scripts` 는 그걸 건너뛴다.
  그대로 두면 호스트에 **조용히 깨진 트리**가 깔린다. 사람 기억 대신 여기서 막는다.

**기존 가드 1건 수정** — `supply-chain-integrity-guard.test.mjs` 의 liveness 단언이
전역 설치 argv 를 `['install', '-g', installSpec]` 로 **정확히** 고정하고 있어
`--ignore-scripts` 삽입에 깨졌다. 플래그는 사이에 낄 수 있게 풀되 **검증된
`installSpec` 으로 고정된다**는 원래 성질(2026-08-15 TOCTOU 방어)은 그대로 유지하도록
정규식을 좁혔다. 이건 가드 완화가 아니다 — 플래그 존재 자체는 위 신규 가드가 별도로
강제하므로 두 성질이 각각 자기 자리에서 지켜진다.

**가드가 실제로 무는지 확인** (전부 실측):

- **FAIL 경로 실배선 확인** — `apps/agent-manager/package.json` 에 `esbuild@^0.25.0`
  을 임시로 넣고 전체 감사 실행 → `next` 트리에서 정확히 그 1건을 짚고 `exit 1`,
  `live` 는 0개로 통과(발행된 latest 에는 없으므로 정확한 동작). 원복 후 통과.
- **해석 층 실측** — `resolveAndAudit()` 에 `esbuild@0.25.0` 을 물려 실제 레지스트리
  해석 → 26 패키지 중 `hasInstallScript` 1건을 검출. 탐지가 mock 이 아니라 실제
  packument 경로로 동작함을 확인.
- `--ignore-scripts` 제거 → 신규 가드가 정확히 그 1건으로 red(`전역 설치가 서드파티
  install script 를 실행한다: ['install', '-g', installSpec],`). 원복 후 16/16.
- 허용목록에 `esbuild` 추가 → **2건** red(빈 집합 단언 + 결합 강제). 원복 후 16/16.
- 수정한 liveness 단언이 여전히 무는지 확인 — `installSpec` 을 `channelSpec` 으로
  바꾸니 정확히 그 테스트가 red. 즉 TOCTOU 고정 성질은 살아 있다.
- 전체 감사 스크립트 5개 + `audit-deploy-branch-deps.mjs` 전부 PASS.
- 가드 4파일 합산 **48/48 pass** (supply-chain 16 / ci-branch-coverage 6 /
  cron-coverage 6 / published-deps 16 + test-registration 4).
- `apps/agent-manager` — `npm run build` 통과, 전체 테스트 **1190 pass / 0 fail**.
- `apps/client` — build 통과, 전체 테스트 **328 pass / 0 fail**.

**로컬 한계 (CI 에서 확인 필요)** — 이 워크트리의 `node_modules` 는 공유 base
체크아웃 심링크인데 그 설치본이 `main` 보다 오래돼 `web-tree-sitter` /
`@node-rs/xxhash` 가 없다. 그래서 `apps/server` 의 `npm test` 는 앞단 `nest build`
에서 TS2307 로 죽는다 — **이번 변경과 무관한 환경 문제**다(두 패키지는
`apps/server/package.json` 과 lockfile 에 정상 선언돼 있어 `npm ci` 하는 CI 에는
존재하고, 이번 diff 는 `ontology` 쪽 파일을 하나도 건드리지 않는다). 서버 테스트는
빌드를 우회해 관련 가드 파일을 직접 실행하는 방식으로 검증했다.

### 5. 이월 (변동 없음, 운영자 판단 필요)

- `react` 18→19, `typeorm` 0.3→1.1, `@hello-pangea/dnd` 17→18, `undici` 7→8 —
  전부 기능 메이저이고 보안 사유 없음. 현 버전은 각 계열의 최신이며 advisory 0건.
- **`node:22-slim` 태그 고정 (신규 이월, 미조치)** — `Dockerfile` 세 스테이지가
  전부 부동(floating) 태그를 쓴다. 액션은 SHA 로 고정돼 있는데 베이스 이미지는
  아니라 일관성이 없다. 다만 다이제스트로 고정하면 **OS 패키지 보안 패치가 멈추는**
  반대 방향 위험이 생기므로, 자동 범프 수단(Dependabot 등) 없이 단독으로 고정하는
  건 순 손해다. 둘을 같이 도입할지는 운영자 판단 사항이라 조치하지 않고 기록만 한다.

## 재검증 로그 — 2026-08-26 (`main` @ `5c6b95e2`)

의존성 변경 없이 새 advisory 와 배포 브랜치 lockfile 드리프트를 다시 점검했다.
`npm audit fix` 는 사용하지 않았으며 루트 `overrides` 도 그대로 유지했다.

| 항목 | 결과 |
| --- | --- |
| `npm audit` (`main`) | **0 vulnerabilities** (prod 276 / dev 307 / optional 85, total 606) |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `production.private` (`df1cfe47`) | **0 vulnerabilities**, root/workspace manifest와 lockfile이 `main`과 동일 |
| 레지스트리 서명 | 105개 서명 및 13개 attestation 검증, 실패 0건 |
| lockfile install script | 3개 (`@scarf/scarf`/`esbuild`/`fsevents`), 전부 허용목록 내 |
| 발행 트리 (live/next) | 93 / 92 패키지, moderate 이상 0건, install script 0개 |
| 공급망·감사·테스트 등록 가드 | **48/48 pass** |

발행 트리에는 lockfile 대비 11개 버전 드리프트가 있었지만 live/next 양쪽 모두
advisory 0건이고 install script도 없었다. `production.private`의 의존성 파일은
`main`과 바이트 동일하므로 별도 수정이나 lockfile 재생성은 필요하지 않았다.
새 `apps/server` 테스트 파일을 추가하지 않았고, 등록 완전성 가드로 기존 테스트가
모두 `package.json`의 `test` 스크립트에 포함된 것도 확인했다.

## 재검증 로그 — 2026-08-27 (`main` @ `0815a7a5`)

최신 원격 refs를 다시 fetch한 뒤 `main`과 실제 배포 브랜치
`production.private`(`70ff4066`)를 함께 감사했다. `npm audit fix`는 사용하지
않았으며 루트 `overrides`도 그대로 유지했다.

| 항목 | 결과 |
| --- | --- |
| `npm audit` (`main`) | **0 vulnerabilities** (prod 280 / dev 306 / optional 85 / peer 1, total 610) |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `production.private` | **0 vulnerabilities**, lockfile과 세 workspace manifest가 `main`과 바이트 동일 |
| 레지스트리 서명 | 105개 서명 및 13개 attestation 검증, 실패 0건 |
| lockfile install script | 3개 (`@scarf/scarf`/`esbuild`/`fsevents`), 전부 허용목록 내 |
| 발행 트리 (live/next) | 93 / 92 패키지, moderate 이상 0건, install script 0개 |
| 공급망·감사·테스트 등록 가드 | **48/48 pass** |

발행 트리의 lockfile 대비 11개 버전 드리프트도 live/next 양쪽 모두 advisory
0건이었다. 배포 브랜치의 루트 `package.json`은 배포와 무관한 agent instruction
동기화 스크립트 두 개만 없고 의존성 선언과 lockfile은 동일하다. 따라서 패키지
업데이트나 lockfile 재생성은 필요하지 않았다. 새 `apps/server` 테스트 파일을
추가하지 않았으며, 등록 완전성 가드로 기존 테스트 전부가 각 `package.json`의
`test` 스크립트에 포함된 것도 재확인했다.

## 재검증 로그 — 2026-08-28 (`main` @ `d45c701a`)

최신 `main`과 배포 브랜치 `production.private`(`344d415a`)를 fetch해 함께 감사했다.
두 브랜치의 root/workspace manifest, lockfile, Dockerfile, `turbo.json`은 모두 동일했다.
`npm audit`과 `npm audit --omit=dev`는 각각 0건이었고, 발행 패키지 live/next 트리도
moderate 이상 0건 및 install script 0개였다. 발행 트리의 lockfile 대비 11개 버전
드리프트는 모두 advisory 0건이었다.

액션 SHA 고정, install-script 허용목록, CI 배포 브랜치·cron 커버리지, 발행 의존성
범위 가드와 테스트 등록 완전성을 포함한 보안 가드 48건도 모두 통과했다. 취약점이나
의존성 드리프트가 없어 패키지 변경과 lockfile 재생성은 하지 않았다. `npm audit fix`는
사용하지 않았고 root `overrides`도 유지했다. 새 `apps/server` 테스트는 추가하지 않았다.

## 재검증 로그 — 2026-08-29 (`main` @ `d0b0986f`)

최신 원격 refs를 fetch한 뒤 `main`과 배포 브랜치 `production.private`(`344d415a`)를
함께 감사했다. 두 브랜치의 root/workspace manifest와 lockfile은 바이트 단위로
동일했다. `npm audit`과 `npm audit --omit=dev`는 각각 0건(총 610 packages)이었고,
레지스트리 서명 105개와 attestation 13개도 모두 검증됐다.

실제 발행 패키지의 live/next 트리는 각각 93/92 packages, moderate 이상 0건,
install script 0개였다. lockfile 대비 13개 버전 드리프트도 모두 advisory 0건이었다.
install-script 허용목록, 액션 SHA 고정, CI 배포 브랜치·cron 커버리지, 발행 의존성
범위 및 테스트 등록 가드 48건이 모두 통과했고, agent-manager build와 전체 테스트도
통과했다. 취약점이나 lockfile drift가 없어 의존성 변경이나 lockfile 재생성은 하지
않았다. `npm audit fix`는 사용하지 않았고 root `overrides`도 유지했다. 새
`apps/server` 테스트는 추가하지 않았다.

## 재검증 로그 — 2026-08-30 (`main` @ `e62ce2e5`)

최신 원격 refs를 fetch한 뒤 `main`과 배포 브랜치
`production.private`(`344d415a`)를 함께 감사했다. root 및 세 workspace의
manifest와 lockfile blob은 두 브랜치에서 모두 동일해 lockfile drift가 없었다.
`npm audit`과 `npm audit --omit=dev`는 각각 **0 vulnerabilities**(총 610
packages)였으며, 레지스트리 서명 105개와 attestation 13개도 모두 검증됐다.

실제 발행 패키지의 live/next 트리는 각각 93/92 packages, moderate 이상 0건,
install script 0개였다. lockfile 대비 14개 버전 드리프트도 모두 advisory
0건이었다. install-script 허용목록, 액션 SHA 고정, CI 배포 브랜치·cron
커버리지, 발행 의존성 범위 및 테스트 등록 가드 **48/48**도 통과했다.
취약점이나 의존성 drift가 없어 패키지 변경과 lockfile 재생성은 하지 않았다.
`npm audit fix`는 사용하지 않았고 root `overrides`도 유지했다. 새
`apps/server` 테스트는 추가하지 않았다.

## 재검증 로그 — 2026-08-31 (`main` @ `e62ce2e5`)

최신 원격 refs를 fetch한 뒤 `main`과 배포 브랜치
`production.private`(`c1625315`)를 함께 감사했다. root 및 세 workspace의
manifest와 lockfile blob은 두 브랜치에서 모두 동일해 lockfile drift가 없었다.
`npm audit`과 `npm audit --omit=dev`는 각각 **0 vulnerabilities**(총 610
packages)였으며, 레지스트리 서명 105개와 attestation 13개도 모두 검증됐다.

실제 발행 패키지의 live/next 트리는 각각 93/92 packages, moderate 이상 0건,
install script 0개였다. lockfile 대비 14개 버전 드리프트도 모두 advisory
0건이었다. install-script 허용목록, 액션 SHA 고정, CI 배포 브랜치·cron
커버리지, 발행 의존성 범위 및 테스트 등록 가드 **48/48**도 통과했다.
취약점이나 의존성 drift가 없어 패키지 변경과 lockfile 재생성은 하지 않았다.
`npm audit fix`는 사용하지 않았고 root `overrides`도 유지했다. 새
`apps/server` 테스트는 추가하지 않았다.

## 재검증 로그 — 2026-09-01 (`main` @ `875cf3e7`)

최신 원격 refs를 fetch한 뒤 `main`과 배포 브랜치
`production.private`(`2f332c93`)를 함께 감사했다. root 및 세 workspace의
manifest와 lockfile blob은 두 브랜치에서 모두 동일해 lockfile drift가 없었다.
`npm audit`과 `npm audit --omit=dev`는 각각 **0 vulnerabilities**였으며,
레지스트리 서명 105개와 attestation 13개도 모두 검증됐다.

실제 발행 패키지의 live/next 트리는 각각 93/92 packages, moderate 이상 0건,
install script 0개였다. lockfile 대비 14개 버전 드리프트도 모두 advisory
0건이었다. install-script 허용목록, 액션 SHA 고정, CI 배포 브랜치·cron
커버리지, 공급망 무결성, 발행 의존성 범위 및 테스트 등록 가드 **48/48**도
통과했다. 취약점이나 의존성 drift가 없어 패키지 변경과 lockfile 재생성은 하지
않았다. `npm audit fix`는 사용하지 않았고 root `overrides`도 유지했다. 새
`apps/server` 테스트는 추가하지 않았다.

## 재검증 로그 — 2026-09-02 (`main` @ `26541422`)

최신 원격 refs를 fetch한 뒤 `main`과 배포 브랜치
`production.private`(`cdb6d75f`)를 함께 감사했다. `production.private`가 해당
`main` 커밋을 포함하고 있으며 root 및 세 workspace의 manifest와 lockfile은
바이트 단위로 동일해 lockfile drift가 없었다. `npm audit`과
`npm audit --omit=dev`는 각각 **0 vulnerabilities**(총 610 packages)였고,
레지스트리 서명 105개와 attestation 13개도 모두 검증됐다.

실제 발행 패키지의 live/next 트리는 각각 93/92 packages, moderate 이상 0건,
install script 0개였다. lockfile 대비 14개 버전 드리프트도 모두 advisory
0건이었다. install-script 허용목록, 액션 SHA 고정, CI 배포 브랜치·cron
커버리지, 공급망 무결성, 발행 의존성 범위 및 테스트 등록 가드 **48/48**도
통과했다. 취약점이나 의존성 drift가 없어 패키지 변경과 lockfile 재생성은 하지
않았다. `npm audit fix`는 사용하지 않았고 root `overrides`도 유지했다. 새
`apps/server` 테스트는 추가하지 않았다.

로컬 공유 `node_modules`가 최신 `main`보다 오래돼 `@ast-grep/napi`,
`web-tree-sitter`, `@node-rs/xxhash`가 없어 전체 server test의 선행 build는
실행할 수 없었다. 세 패키지는 manifest와 lockfile에 정상 등록돼 있으며, 이번
감사의 독립 보안 가드 48건은 build 없이 직접 실행해 모두 통과했다.
