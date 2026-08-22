// Ontology Graph UI 셸 배선 회귀 테스트 (ticket d22b83b4).
//
// navigation-ia.test.mjs와 같은 자세 — 소스를 문자열로 읽어 정적으로
// grep한다(라우트/사이드바 배선 완전성 확인엔 jsdom 렌더가 불필요).
// 프레시니스 배지 자체의 로직은 순수 함수라 ontology-freshness.test.mjs가
// 따로 검증한다 — 여기서는 "그 로직이 실제로 페이지에 배선돼 있는가"만 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [sidebarSource, appSource, apiSource, typesSource, pageSource] = await Promise.all([
  readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/ontology/OntologyGraphPage.tsx', import.meta.url), 'utf8'),
]);

test('사이드바 Knowledge 섹션에 Ontology Graph 항목이 Resources/Prompt Templates와 같은 그룹으로 있다', () => {
  assert.match(sidebarSource, /title: 'Knowledge'[\s\S]*?key: 'ontology-graph'[\s\S]*?\],\s*\},/);
  assert.match(sidebarSource, /path: `\$\{workspaceBase\}\/ontology-graph`/);
});

test('App.tsx가 OntologyGraphPage를 지연 로드하고 ws/:wsId 하위에 라우트를 건다(Orchestration과 같은 패턴)', () => {
  assert.match(appSource, /const OntologyGraphPage = lazy\(\(\) => import\('\.\/components\/ontology\/OntologyGraphPage'\)\)/);
  assert.match(appSource, /<Route path="ontology-graph" element={<OntologyGraphPage \/>} \/>/);
  // WorkspaceManagementPage의 kind 스위치(CRUD-list 패턴)로 억지로 끼워넣지
  // 않았는지 — 자기 라우트 element가 WorkspaceManagementPage가 아니어야 한다.
  assert.doesNotMatch(appSource, /path="ontology-graph" element={<WorkspaceManagementPage/);
});

test('api.ts가 그래프 상태 조회 + 재방문 로깅 엔드포인트를 노출한다', () => {
  assert.match(apiSource, /getOntologyGraphStatus:/);
  assert.match(apiSource, /\/ontology\/status/);
  assert.match(apiSource, /logOntologyGraphViewOpened:/);
  assert.match(apiSource, /\/ontology\/view-opened/);
});

test('types.ts가 상태 응답 + SSE 진행 이벤트 타입을 노출하고 dirty_ratio/behind/ahead 필드를 포함한다', () => {
  assert.match(typesSource, /export interface OntologyGraphStatusResponse/);
  assert.match(typesSource, /dirty_ratio: number \| null/);
  assert.match(typesSource, /behind: number \| null/);
  assert.match(typesSource, /export interface OntologyGraphProgressEvent/);
});

test('OntologyGraphPage는 하드코딩 hex 컬러 리터럴 없이 tokens만 쓴다(scout-client.md §2)', () => {
  assert.doesNotMatch(pageSource, /#[0-9a-fA-F]{3,6}\b/, 'raw hex color literal found — use tokens.colors.* instead');
  assert.match(pageSource, /from '\.\.\/\.\.\/tokens'/);
});

test('OntologyGraphPage는 building 상태에서만 폴링하고 ready/error 도달 시 멈춘다(완료조건 1)', () => {
  assert.match(pageSource, /isBuilding = statusResp\?\.status === 'building'/);
  assert.match(pageSource, /setInterval\(\(\) => void load\(\{ silent: true \}\), POLL_MS\)/);
  assert.match(pageSource, /clearInterval/);
});

test('OntologyGraphPage는 이미 배선된 ontology_graph_progress SSE를 구독한다(server 쪽은 964014f5가 이미 완료)', () => {
  assert.match(pageSource, /useBoardStreamEvent\('ontology_graph_progress'/);
});

test('OntologyGraphPage는 선택 변경 시 재방문을 로깅하되 폴링 tick마다는 재로깅하지 않는다(Done-when)', () => {
  assert.match(pageSource, /logOntologyGraphViewOpened/);
  assert.match(pageSource, /loggedViewKey/);
});

test('OntologyGraphPage는 freshnessBadge 순수 함수를 그대로 소비한다(로직 중복 구현 금지)', () => {
  assert.match(pageSource, /import \{ freshnessBadge, type FreshnessTone \} from '\.\/freshness'/);
});
