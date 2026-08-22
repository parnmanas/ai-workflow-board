// 회귀 테스트 — ticket b646ed54
// "ensureSqljsDbHealthy() 손상 가드를 database/ontology.db 에도 확장"
//
// 배경(ticket 6ca4894a): sql.js(dev) 전용 온톨로지 테이블을 위해 독립적으로
// flush되는 두 번째 DataSource(AppOntologyDataSource, database/ontology.db)가
// db.ts에 추가됐다. 기존 primary data.db는 ensureSqljsDbHealthy()(ticket
// e9847153)가 TypeORM initialize() 이전에 sql.js로 직접 PRAGMA
// integrity_check를 돌려, 손상된 파일이 만드는 ~25초 hang(에이전트 subagent가
// exit 143으로 죽는 원인)을 <1초 안에 감지해 막는다 — 그런데 이 가드는
// resolveSqljsLocation()(primary 경로)만 검사하도록 하드코딩되어 있었다.
//
// 이 스위트는 새로 추가된 ensureOntologySqljsDbHealthy()가 (1) 정상/부재
// 파일에는 부수효과 없이 통과하고, (2) 손상된 ontology.db를
// AWB_DB_AUTORECOVER=1 아래서 정확히 primary와 같은 방식(백업 후 제거)으로
// 복구하며, (3) 그 복구 이후 AppOntologyDataSource.initialize()가 실제로
// 손상 파일을 다시 만나지 않고 성공한다는 것 — 즉 가드가 없었다면 발생했을
// hang을 실제로 막는다는 것 — 을 증명한다. 리팩터로 두 가드가
// checkAndRecoverSqljsFile()이라는 공유 코어를 쓰게 됐으므로, 기존
// ensureSqljsDbHealthy()(primary)가 이 리팩터 이후에도 같은 동작을 유지하는지도
// 함께 검증한다.
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요, test 스크립트가
// 보장). 격리된 SQLJS_DB_PATH / SQLJS_ONTOLOGY_DB_PATH 임시 파일을 써서
// 공유 dev database/*.db는 절대 건드리지 않는다.

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-corruption-guard-'));
const primaryPath = path.join(tmpDir, 'primary.db');
const ontologyPath = path.join(tmpDir, 'ontology.db');

process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = primaryPath;
process.env.SQLJS_ONTOLOGY_DB_PATH = ontologyPath;
process.env.NODE_ENV = 'test';
delete process.env.AWB_DB_AUTORECOVER;

const dbUrl = 'file://' + path.join(DIST_ROOT, 'db.js');
const {
  ensureSqljsDbHealthy,
  ensureOntologySqljsDbHealthy,
  resolveSqljsLocation,
  resolveOntologySqljsLocation,
  AppOntologyDataSource,
  flushOntologySqljs,
} = await import(dbUrl);

function corruptBackupsFor(location) {
  const dir = path.dirname(location);
  const base = path.basename(location);
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`));
}

function writeGarbage(location) {
  fs.writeFileSync(location, Buffer.from('not a real sqlite file — corrupt for test b646ed54'));
}

describe('ensureOntologySqljsDbHealthy() — corruption guard extended to database/ontology.db (ticket b646ed54)', () => {
  afterEach(() => {
    delete process.env.AWB_DB_AUTORECOVER;
    for (const p of [primaryPath, ontologyPath]) {
      try { fs.rmSync(p, { force: true }); } catch { /* 최선 노력 정리 */ }
      for (const backup of corruptBackupsFor(p)) {
        try { fs.rmSync(path.join(path.dirname(p), backup), { force: true }); } catch { /* 최선 노력 정리 */ }
      }
    }
  });

  after(async () => {
    if (AppOntologyDataSource?.isInitialized) await AppOntologyDataSource.destroy();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 최선 노력 정리 */ }
  });

  it('resolveOntologySqljsLocation() (not the primary resolver) is the file this guard checks', () => {
    assert.equal(resolveOntologySqljsLocation().location, ontologyPath);
    assert.notEqual(resolveOntologySqljsLocation().location, resolveSqljsLocation().location);
  });

  it('a missing ontology.db is a no-op — the guard never creates the file itself', async () => {
    assert.equal(fs.existsSync(ontologyPath), false);
    await assert.doesNotReject(() => ensureOntologySqljsDbHealthy());
    assert.equal(fs.existsSync(ontologyPath), false, 'sql.js, not the guard, is responsible for creating a fresh file on initialize()');
  });

  it('a corrupt ontology.db is backed up and removed under AWB_DB_AUTORECOVER=1, mirroring the primary guard', async () => {
    writeGarbage(ontologyPath);
    process.env.AWB_DB_AUTORECOVER = '1';

    await ensureOntologySqljsDbHealthy();

    assert.equal(fs.existsSync(ontologyPath), false, 'the corrupt file must be moved out of the way, not left in place');
    const backups = corruptBackupsFor(ontologyPath);
    assert.equal(backups.length, 1, 'exactly one corrupt-<ts> backup must be created');
    const backupContent = fs.readFileSync(path.join(tmpDir, backups[0]), 'utf8');
    assert.match(backupContent, /corrupt for test b646ed54/, 'the backup must preserve the original (corrupt) bytes, not discard them');
  });

  it('end-to-end: after auto-recovery, AppOntologyDataSource.initialize() succeeds against a fresh DB instead of hanging on the corrupt file', async () => {
    writeGarbage(ontologyPath);
    process.env.AWB_DB_AUTORECOVER = '1';

    await ensureOntologySqljsDbHealthy();
    assert.equal(fs.existsSync(ontologyPath), false);

    await AppOntologyDataSource.initialize();
    try {
      assert.equal(AppOntologyDataSource.isInitialized, true);
      // autoSave는 OFF다(ticket d5a8594a 배치-flush 설계) — initialize()만으로는
      // 아직 디스크에 아무것도 쓰이지 않는다. 명시적으로 flush해야 실제로
      // 파일이 생긴다는 것까지 확인해서, "hang 없이 초기화됐다"만이 아니라
      // "그 결과가 실제로 정상 동작하는 새 DB다"까지 증명한다.
      await flushOntologySqljs(AppOntologyDataSource, true);
      assert.equal(fs.existsSync(ontologyPath), true, 'sql.js must have created a fresh, healthy file in place of the recovered-away corrupt one');
    } finally {
      await AppOntologyDataSource.destroy();
    }
  });

  it('regression: the primary ensureSqljsDbHealthy() keeps its exact recover-then-remove behavior after the shared-core refactor', async () => {
    writeGarbage(primaryPath);
    process.env.AWB_DB_AUTORECOVER = '1';

    await ensureSqljsDbHealthy();

    assert.equal(fs.existsSync(primaryPath), false);
    const backups = corruptBackupsFor(primaryPath);
    assert.equal(backups.length, 1, 'the primary guard must still produce exactly one corrupt-<ts> backup post-refactor');
  });
});
