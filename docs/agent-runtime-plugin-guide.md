# Agent 런타임 플러그인 추가

1. adapter 모듈을 만들고 provider argv/body, 환경변수, SDK 타입을 그 모듈 안에 가둔다.
2. `defineRuntimePlugin`으로 고유 id, `cli|acp|llm` transport, request capability, 해당 factory를 선언한다.
3. composition root의 registry에 manifest를 등록한다. 코어 application, 기존 adapter, provider union이나 switch는 수정하지 않는다.
4. 정규 요청을 `negotiateCapabilities`에 통과시킨 뒤 adapter의 최종 argv/body를 만든다. 미지원 effort, resume, MCP, streaming 값은 여기서 제거된다.
5. registry contract와 정규 요청→최종 transport contract test를 추가한다. Credential 원문, prompt 원문, provider 응답 객체를 telemetry/error에 넣지 않는다.

`test/runtime-plugin-registry.test.mjs`의 fixture는 별도 manifest 등록만으로 discovery와 생성이 되는 최소 예제다. Registry는 부팅 후 seal되므로 hot path 조회는 Map 기반 O(1)이고 런타임 동적 import를 하지 않는다.

## CLI 모듈 (2026-09)

내장 런타임은 이제 `src/lib/clis/<id>/index.ts` 의 `CliModule` 로 선언한다 — 위 manifest
(`defineRuntimePlugin`)의 상위 집합으로, 어댑터 팩토리와 capability 에 바이너리·credential·
로그인·Agent Session·effort·디스패치 슬라이스를 얹는다. `composeRuntime(extensions)` 로 넣는
외부 manifest 는 그대로 동작하며 슬라이스가 없으면 "미지원" 으로 읽힌다. 절차는
`docs/runbooks/cli-module-wiring.md`, 설계는 `docs/cli-modules.md`.
