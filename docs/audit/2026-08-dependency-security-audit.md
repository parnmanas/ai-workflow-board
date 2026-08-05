# 의존성 패키지 보안 감사 (2026-08-05)

`ai-workflow-board` 모노레포(`apps/server`, `apps/client`, `apps/agent-manager`)가
사용하는 npm 패키지와 그 버전에 대한 취약점 전수 감사 기록이다.

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
