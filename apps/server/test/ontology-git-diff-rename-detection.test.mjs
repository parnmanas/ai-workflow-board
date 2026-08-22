// 회귀 테스트 — ticket 964014f5, git-repo-cache.ts의
// `diffChangedPathsWithStatus()`(git diff --name-status -M 래퍼). 실제
// 임시 git 저장소(git init)를 만들어 add/modify/delete/rename을 한 커밋
// 안에 섞어 커밋하고, 이 함수가 각 상태를 정확히 파싱하는지 검증한다 —
// incremental/git-diff-batch.ts가 이 파싱 결과로 Phase A의 rename 분기
// (REVIEW-NOTES.md I2)를 트리거하므로, rename 파싱이 틀리면 그 안전장치
// 전체가 조용히 무력화된다. 컴파일된 dist/ 대상(server 계열 관례).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const { diffChangedPathsWithStatus } = await import(
  'file://' + path.join(DIST_ROOT, 'modules/mcp/shared/git-repo-cache.js')
);

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-git-diff-status-'));

function git(args) {
  return execFileSync('git', args, { cwd: repoDir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).toString().trim();
}

let commit1, commit2;

before(() => {
  git(['init', '-q']);
  git(['config', 'user.email', 'test@awb.local']);
  git(['config', 'user.name', 'AWB Test']);
  fs.mkdirSync(path.join(repoDir, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'pkg', 'util.ts'), 'export function helper() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(repoDir, 'stays.ts'), 'export const stable = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'to-delete.ts'), 'export const gone = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'c1']);
  commit1 = git(['rev-parse', 'HEAD']);

  // 한 커밋 안에 rename(git mv, 내용 동일) + add + modify + delete를 섞는다.
  fs.mkdirSync(path.join(repoDir, 'moved'), { recursive: true });
  git(['mv', 'pkg/util.ts', 'moved/util.ts']);
  fs.writeFileSync(path.join(repoDir, 'added.ts'), 'export const brandNew = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'stays.ts'), 'export const stable = 2;\n');
  fs.rmSync(path.join(repoDir, 'to-delete.ts'));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'c2']);
  commit2 = git(['rev-parse', 'HEAD']);
});

after(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('diffChangedPathsWithStatus — git diff --name-status -M 파싱', () => {
  it('rename/add/modify/delete가 섞인 커밋을 status별로 정확히 분류한다', async () => {
    const changes = await diffChangedPathsWithStatus(repoDir, commit1, commit2);
    const byPath = new Map(changes.map((c) => [c.path, c]));

    const renamed = byPath.get('moved/util.ts');
    assert.ok(renamed, 'rename 결과는 새 경로(path)로 조회돼야 한다');
    assert.equal(renamed.status, 'R');
    assert.equal(renamed.oldPath, 'pkg/util.ts');
    assert.equal(renamed.similarity, 100, '내용을 안 바꾼 순수 rename이므로 유사도 100');

    const added = byPath.get('added.ts');
    assert.ok(added);
    assert.equal(added.status, 'A');
    assert.equal(added.oldPath, null);

    const modified = byPath.get('stays.ts');
    assert.ok(modified);
    assert.equal(modified.status, 'M');
    assert.equal(modified.oldPath, null);

    const deleted = byPath.get('to-delete.ts');
    assert.ok(deleted);
    assert.equal(deleted.status, 'D');
    assert.equal(deleted.oldPath, null);

    // rename으로 인식됐으므로 옛 경로 자체는 별도 D 항목으로 안 나와야 한다
    // (git -M이 D+A 대신 R 하나로 합쳐 보고하는 것이 이 함수가 기대는 전제).
    assert.ok(!byPath.has('pkg/util.ts'));
  });

  it('잘못된 ref는 GitReadError로 거부한다(다른 git-repo-cache 함수와 동일한 검증 규율)', async () => {
    await assert.rejects(() => diffChangedPathsWithStatus(repoDir, '--upload-pack=x', commit2));
  });
});
