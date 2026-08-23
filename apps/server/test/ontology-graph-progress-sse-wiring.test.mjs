// 회귀 테스트 — ticket 964014f5, 완료조건 4: `ontology_graph_progress` SSE
// 프레임이 server(event-registry.ts) + client(BoardStreamContext.tsx)
// 양쪽에 실제로 배선돼 있는지 확인한다(CLAUDE.md Agent Manager sync
// 규칙 — SSE 이벤트 타입은 server+client 같은 PR).
//
// event-registry-payload-parity-guard.test.mjs가 stream-events.ts의 모든
// Payload 인터페이스 필드가 map()에서 누락 없이 커버되는지를 이미
// 일반적으로 검증하므로, 여기서는 그걸 반복하지 않고 (1) 이 이벤트가
// 실제로 map/filter/flatten을 갖고 올바르게 동작하는지, (2) 클라이언트
// 쪽 union 타입 + connect() 리스너가 실존하는지(정적 grep)만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { EVENT_TYPES } = await import('../dist/modules/events/event-registry.js');

const def = EVENT_TYPES.find((d) => d.eventType === 'ontology_graph_progress');

test('ontology_graph_progress 정의가 registry에 존재하고 map/filter/flatten을 모두 갖는다', () => {
  assert.ok(def, 'ontology_graph_progress 엔트리가 event-registry.ts EVENT_TYPES에 없다');
  assert.equal(def.emitterEvent, 'ontology_graph_progress');
  assert.equal(typeof def.map, 'function');
  assert.equal(typeof def.filter, 'function');
  assert.equal(
    typeof def.flatten,
    'function',
    'flatten이 없으면 클라이언트가 payload가 아니라 envelope 전체를 받는다(user-mention 사례 재발)',
  );
});

test('map()이 실제 emit 페이로드를 workspace 스코프 + 필드 그대로의 payload로 변환한다', () => {
  const emitted = {
    workspace_id: 'ws-1',
    graph_id: 'g-1',
    resource_id: 'r-1',
    job_id: 'job-1',
    phase: 'phase_b',
    graph_status: 'building',
    files_processed: 3,
    edges_extracted: 12,
    edges_total: 12,
    nodes_extracted: 0,
    short_circuited: false,
    error: null,
    timestamp: '2026-08-22T00:00:00.000Z',
  };
  const envelope = def.map(emitted);
  assert.equal(envelope.payload.workspace_id, 'ws-1');
  assert.equal(envelope.payload.graph_id, 'g-1');
  assert.equal(envelope.payload.phase, 'phase_b');
  assert.equal(envelope.payload.graph_status, 'building');
  assert.equal(envelope.payload.edges_extracted, 12);
  assert.equal(envelope.payload.short_circuited, false);
  assert.deepEqual(envelope.scope, { workspace_id: 'ws-1' });
});

test('flatten()은 payload 필드를 top-level로 노출한다(envelope 키가 아니라)', () => {
  const emitted = {
    workspace_id: 'ws-1',
    graph_id: 'g-1',
    resource_id: 'r-1',
    job_id: 'job-1',
    phase: 'phase_a',
    graph_status: 'ready',
    files_processed: 1,
    edges_extracted: 0,
    edges_total: 0,
    nodes_extracted: 0,
    short_circuited: true,
    error: null,
    timestamp: '2026-08-22T00:00:00.000Z',
  };
  const envelope = def.map(emitted);
  const frame = def.flatten({ ...envelope, event_type: 'ontology_graph_progress', timestamp: emitted.timestamp });
  assert.equal(frame.event_type, 'ontology_graph_progress');
  assert.equal(frame.graph_id, 'g-1', 'graph_id가 top-level에 있어야 클라이언트가 data.graph_id로 바로 읽는다');
  assert.equal(frame.short_circuited, true);
  assert.equal(frame.payload, undefined, '봉투 그대로 새면 안 된다 — flatten이 payload를 펼쳐야 한다');
});

test('filter()는 UI 전용(agent-manager 비소비) — orchestration_update/consensus_update와 같은 user-only 자세', () => {
  assert.equal(def.filter({ scope: { workspace_id: 'ws-1' } }, { type: 'user', userId: 'u-1' }), true);
  assert.equal(def.filter({ scope: { workspace_id: 'ws-1' } }, { type: 'agent', agentId: 'a-1' }), false);
});

test('클라이언트(BoardStreamContext.tsx)에 ontology_graph_progress 유니온 리터럴 + connect() 리스너가 실존한다(server+client 같은 PR)', () => {
  const clientFile = path.join(__dirname, '..', '..', 'client', 'src', 'contexts', 'BoardStreamContext.tsx');
  const src = fs.readFileSync(clientFile, 'utf8');
  assert.match(
    src,
    /StreamNamedEventType\s*=[\s\S]*?'ontology_graph_progress'/,
    'StreamNamedEventType 유니온에 ontology_graph_progress 리터럴이 없다',
  );
  assert.match(
    src,
    /eventSource\.addEventListener\('ontology_graph_progress'/,
    "connect() 안에 ontology_graph_progress addEventListener 블록이 없다",
  );
});

test('서버(stream-events.ts) StreamEventType 유니온에도 ontology_graph_progress가 있다', () => {
  const serverTypesFile = path.join(__dirname, '..', 'src', 'common', 'types', 'stream-events.ts');
  const src = fs.readFileSync(serverTypesFile, 'utf8');
  assert.match(src, /StreamEventType\s*=[\s\S]*?'ontology_graph_progress'/);
});
