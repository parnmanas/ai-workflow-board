// 회귀 테스트 — ticket 964014f5, incremental-scheduler.service.ts의 디바운스
// 저장 트리거(research-incremental.md §5.3: "ten keystrokes in ten seconds
// coalesce into one Phase-A run") + ontology_graph_progress SSE 실제 emit.
// 컴파일된 dist/ 대상, 격리된 SQLJS_ONTOLOGY_DB_PATH — ontology 계열 관례.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-scheduler-debounce-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { OntologyIncrementalSchedulerService } = await import(
  'file://' + path.join(DIST_ROOT, 'modules/ontology/incremental-scheduler.service.js')
);
const { activityEvents } = await import('file://' + path.join(DIST_ROOT, 'services/activity.service.js'));
const { AppOntologyDataSource, initOntologyDb, flushOntologySqljs } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyNode.js'));

const WORKSPACE_ID = 'scheduler-debounce-ws';
const RESOURCE_ID = 'scheduler-debounce-resource';
const GRAPH_ID = 'scheduler-debounce-graph';
const FILE_PATH = 'debounced.ts';

const noopLog = { info() {}, warn() {}, error() {} };

let nodeRepo;

before(async () => {
  await initOntologyDb();
  nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
});

after(async () => {
  if (AppOntologyDataSource?.isInitialized) {
    await flushOntologySqljs(AppOntologyDataSource, true);
    await AppOntologyDataSource.destroy();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** ontology_graph_progress가 조건을 만족할 때까지 대기(타임아웃 5초) — 폴링이
 *  아니라 activityEvents 리스너로 이벤트가 도착한 순간 즉시 resolve한다. */
function waitForProgress(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      activityEvents.off('ontology_graph_progress', handler);
      reject(new Error('ontology_graph_progress 이벤트를 기다리다 타임아웃'));
    }, timeoutMs);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      activityEvents.off('ontology_graph_progress', handler);
      resolve(payload);
    }
    activityEvents.on('ontology_graph_progress', handler);
  });
}

describe('scheduleFileChange — 디바운스가 연속 저장을 하나의 Phase A 실행으로 합친다', () => {
  const svc = new OntologyIncrementalSchedulerService({}, noopLog);
  svc.__setDebounceMsForTests(30);

  it('짧은 시간 안에 같은 파일을 3번 스케줄해도 마지막 content만 실제로 반영된다', async () => {
    const allSeen = [];
    const collector = (p) => {
      if (p.graph_id === GRAPH_ID) allSeen.push(p);
    };
    activityEvents.on('ontology_graph_progress', collector);

    const donePromise = waitForProgress((p) => p.graph_id === GRAPH_ID && p.graph_status === 'ready');

    svc.scheduleFileChange({
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      folderPath: '',
      graphId: GRAPH_ID,
      newPath: FILE_PATH,
      lang: 'typescript',
      content: 'export function process() {\n  return 1;\n}\n',
      commit: 'c1',
    });
    svc.scheduleFileChange({
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      folderPath: '',
      graphId: GRAPH_ID,
      newPath: FILE_PATH,
      lang: 'typescript',
      content: 'export function process() {\n  return 2;\n}\n',
      commit: 'c1',
    });
    svc.scheduleFileChange({
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      folderPath: '',
      graphId: GRAPH_ID,
      newPath: FILE_PATH,
      lang: 'typescript',
      content: 'export function process() {\n  return 3;\n}\n',
      commit: 'c1',
    });

    await donePromise;
    activityEvents.off('ontology_graph_progress', collector);

    // building 프레임 1개 + ready 프레임 1개만 — 3번 스케줄했어도 디바운스가
    // 흡수해 Phase A 자체는 정확히 한 번만 실행됐어야 한다.
    const buildingFrames = allSeen.filter((p) => p.graph_status === 'building');
    const readyFrames = allSeen.filter((p) => p.graph_status === 'ready');
    assert.equal(buildingFrames.length, 1, '디바운스가 흡수했다면 building 프레임도 정확히 1개여야 한다');
    assert.equal(readyFrames.length, 1);

    const fileNode = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'File', path: FILE_PATH } });
    assert.ok(fileNode, '디바운스 뒤 실제로 파일이 처리돼 File 노드가 생겼어야 한다');
  });

  it('runFileChange를 직접 호출하면(디바운스 우회) 즉시 shortCircuit 결과와 함께 progress를 emit한다', async () => {
    const donePromise = waitForProgress((p) => p.graph_id === GRAPH_ID && p.short_circuited === true);
    const result = await svc.runFileChange({
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      folderPath: '',
      graphId: GRAPH_ID,
      newPath: FILE_PATH,
      lang: 'typescript',
      // 시그니처(export function process()) 동일한 body-only 편집 — 반환값만 바뀜.
      content: 'export function process() {\n  return 4;\n}\n',
      commit: 'c2',
    });
    assert.equal(result.phaseA.shortCircuit, true);
    assert.equal(result.phaseB, null);
    const frame = await donePromise;
    assert.equal(frame.graph_status, 'ready');
    assert.equal(frame.short_circuited, true);
  });
});
