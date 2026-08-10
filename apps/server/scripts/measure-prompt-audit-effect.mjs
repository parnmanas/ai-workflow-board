#!/usr/bin/env node
// Prompt-audit effect measurement (ticket ec498050, Planner decision Q3).
//
// 4개 지표(start_rate, unnecessary_questions, pending_misclassification_rate,
// completion_rate)를 ActivityLog + Comment에서 계산한다(Planner's fixed
// formula — "산식은 후속 티켓이 그대로 재실행할 수 있게 스크립트에 고정").
// 지표 전체 정의와 ActivityLog 형태상의 함정은 `computeReport()` 자체의 doc
// comment로 `../src/common/prompt-audit-report.ts`에 있다 — 그 모듈이 단일
// 소스다(f3fc298a가 이관 — `prompt_audit.measure_effect` builtin Function이
// 별도 DB 자격증명 없이 서버 프로세스 안에서 동일 산식을 그대로 호출할 수
// 있게 하기 위함).
//
// This script is READ-ONLY (no writes) but still calls buildDataSourceOptions()
// + DataSource.initialize(), which runs TypeORM `synchronize` (D-01, always on)
// against whatever DB the env points to — harmless schema-only alignment, same
// as every qa-flow test already does, but be deliberate about which DB you
// point this at (see Usage). This script does NOT default to any live/shared
// DB_HOST — every Postgres field must be supplied explicitly, and the sqlite
// fallback only ever touches the LOCAL server/database/data.db your own shell
// is already configured for (same file `npm run dev` would open).
//
// 별도 자격증명 없이 production DB를 측정하려면, 대신 `prompt_audit.measure_effect`
// builtin Function을 MCP `execute_function`으로 실행하라 — 이미 연결된 서버
// 프로세스 안에서 바로 이 `computeReport()`를 그대로 재사용한다.
//
// `computeReport()`는 (컴파일된 dist/ 모듈에서 가져와) re-export된다 —
// `test/measure-prompt-audit-effect.test.mjs`가 시드된 fixture DataSource에
// 대해 직접 호출할 수 있도록. 아래 CLI `main()`은 얇은 wrapper(인자 파싱 +
// DataSource lifecycle + 출력)일 뿐이다.
//
// Usage:
//   node apps/server/scripts/measure-prompt-audit-effect.mjs \
//     [--since 2026-07-01T00:00:00Z] [--until 2026-07-31T00:00:00Z] \
//     [--workspace <workspace_id>] [--json]
//
//   DB_TYPE=postgres DB_HOST=... DB_PORT=... DB_USER=... DB_PASS=... DB_NAME=... \
//     node apps/server/scripts/measure-prompt-audit-effect.mjs --since ... --until ...
//
// Build first so dist/ exists: (cd apps/server && npm run build)

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = argv[++i];
  }
  return out;
}

export const { computeReport } = await import('file://' + path.join(DIST, 'common', 'prompt-audit-report.js'));

function printReport(report) {
  console.log(`\n프롬프트 정비 효과 측정 — ${report.window.since} ~ ${report.window.until}${report.workspace_id ? ` (workspace=${report.workspace_id})` : ' (전체 워크스페이스)'}\n`);
  const pct = (r) => (r == null ? 'N/A' : (r * 100).toFixed(1) + '%');
  console.log(`1. 착수율(start_rate): ${report.start_rate.also_advanced}/${report.start_rate.entered_active} = ${pct(report.start_rate.rate)}`);
  console.log(`2. 불필요 질문 수(unnecessary_questions): ${report.unnecessary_questions}건`);
  console.log(`3. pending 오분류율(pending_misclassification_rate): ${report.pending_misclassification_rate.misclassified}/${report.pending_misclassification_rate.pend_events} = ${pct(report.pending_misclassification_rate.rate)}`);
  console.log(`4. 완료율(completion_rate): ${report.completion_rate.completed}/${report.completion_rate.created} = ${pct(report.completion_rate.rate)}\n`);
  console.log('JSON 전체 출력: --json 플래그 사용');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const until = args.until ? new Date(args.until) : undefined;
  const since = args.since ? new Date(args.since) : undefined;
  if ((args.since && Number.isNaN(new Date(args.since).getTime())) || (args.until && Number.isNaN(new Date(args.until).getTime()))) {
    console.error('Invalid --since/--until — expected an ISO 8601 timestamp.');
    process.exit(1);
  }

  const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
  const { DataSource } = await import('typeorm');
  const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
  const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
  const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
  const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
  const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));

  const ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();
  try {
    const report = await computeReport(ds, { ActivityLog, Comment, Ticket, BoardColumn, Board }, {
      since, until, workspaceId: args.workspace,
    });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
  } finally {
    await ds.destroy();
  }
}

// Only auto-run as a CLI — importing computeReport for tests must not trigger main().
if (import.meta.url === 'file://' + process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
