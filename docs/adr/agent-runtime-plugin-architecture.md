# ADR: Agent 런타임 플러그인 계층

## 상태

채택됨.

## 결정

런타임은 `domain → ports → application → adapters → composition` 방향으로만 의존한다. Domain은 정규화 요청·결과·오류·capability만 소유하며 CLI argv, 환경변수, Node process, provider SDK 타입을 알지 못한다. Application은 port와 domain만 사용한다. Adapter는 외부 형식을 정규 계약으로 변환하고 composition만 구체 구현을 조립한다.

각 구현은 immutable `RuntimePluginManifest`로 id, transport, capability, factory를 선언한다. `RuntimePluginRegistry`는 중복 id와 transport별 factory 누락을 부팅 시 거부하고 seal 이후 변경을 금지한다. `RuntimeAdapterResolver`는 실행 소유자 단위로 adapter를 한 번 만들고 재사용한다. 기존 공개 진입점인 `createAdapter`, `getRuntimeDescriptor`, `createRuntimeOwner`는 이 단일 registry에 위임한다. 따라서 descriptor map, adapter switch, manager별 cache의 이중 진실 원천은 제거된다.

Capability 협상은 모든 정규화 요청의 adapter 진입 전에 수행한다. 미지원 option은 경고용 `omitted` 목록에 기록하고 요청에서 제거한다. Credential은 domain 필드가 아니며 composition에서 adapter에 opaque하게 주입해야 한다.

Production의 `SubagentManager`와 `BaseSessionManager`는 adapter의 argv builder를 직접 호출하지 않는다. 두 경로 모두 `RuntimeAdapterResolver.buildOneshot/buildSession`을 거쳐 `RuntimeExecutionFacade`에서 협상된 요청만 최종 adapter 경계로 전달한다. 제목 생성은 one-shot 경로를, 새 persistent session과 resume는 session 경로를 공유한다.

## 결과

새 구현은 새 모듈에서 manifest를 정의하고 composition에 등록한다. 코어 use case, 기존 adapter, provider union, factory switch를 수정하지 않는다. 계층 위반은 `runtime-architecture-boundaries.test.mjs`, open-closed와 capability 필터링은 `runtime-plugin-registry.test.mjs`가 막는다.
