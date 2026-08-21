#!/usr/bin/env node
/**
 * audit-cron-coverage.mjs
 *
 * 공급망 가드 — `ci.yml` 의 의존성 감사가 **시간축으로도** 돌게 강제한다.
 *
 * 왜 필요한가(2026-08-21 의존성 감사에서 발견): 그때까지 ci.yml 트리거는 전부
 * 이벤트 구동이었다 — pull_request / push(main, production.private) /
 * workflow_dispatch. 그런데 `npm audit` 이 판정하는 건 "우리 lockfile 이
 * 바뀌었는가" 가 아니라 "이 버전에 대해 advisory 가 새로 나왔는가" 이고, 그 둘은
 * 완전히 독립적이다. **의존성을 한 줄도 건드리지 않아도** 어제까지 깨끗하던 버전에
 * 오늘 CVE 가 붙는다. 이벤트 구동만 있으면 그 취약점은 "누군가 의존성을 건드리는
 * 다음 push" 까지 아무도 보지 않는다 — 실제 이 저장소에서 lockfile 이 몇 주씩
 * 그대로인 구간이 있었고, 그 사이에도 배포는 계속 나갔다. 그 공백은 지금까지
 * 사람/에이전트의 수동 감사로만 메워졌다(= 이 가드를 낳은 그 감사).
 *
 * 두 가지를 본다:
 *   1) ci.yml 에 `schedule:` 트리거가 살아 있는가 — 없으면 정기 재감사가 사라진다.
 *   2) dependency-audit 을 뺀 모든 잡이 `github.event_name != 'schedule'` 로
 *      스킵되는가 — 안 그러면 새로 추가된 무거운 잡(npm ci + 전체 매트릭스 +
 *      windows 축)이 매일 조용히 돌기 시작한다. cron 이 태울 것은 lockfile 만 읽는
 *      수 초짜리 감사 잡 하나뿐이다.
 *
 * (2)를 굳이 가드하는 이유: 조건이 잡마다 반복되는 형태라 새 잡을 추가하는 사람이
 * 빠뜨리기 쉽고, 빠뜨려도 CI 는 초록이라 아무도 모른다 — 비용/노이즈로만 새는
 * 침묵형 회귀다. 여기서 FAIL 시켜 "이 잡을 cron 에서 돌릴 것인가" 를 명시적 결정으로
 * 만든다.
 *
 * 의존성 없이 들여쓰기 기반으로 읽는다(저장소에 YAML 파서를 새로 들이지 않기 위함).
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI_YML = join(root, '.github', 'workflows', 'ci.yml');

/** cron 만 돌아야 하는(=schedule 에서 스킵하지 않아도 되는) 잡. */
export const CRON_ONLY_JOBS = ['dependency-audit'];

/**
 * `on:` 블록에 schedule 트리거가 있고 cron 식이 하나 이상 달렸는지.
 * 반환: cron 문자열 배열(트리거 없으면 빈 배열).
 */
export function scheduleCrons(yaml) {
  const lines = yaml.split('\n');
  let i = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (i < 0) return [];
  i += 1;

  let at = -1;
  for (; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^\S/.test(l) && l.trim() !== '') break; // on: 블록 종료
    if (/^\s{2}schedule:\s*$/.test(l)) {
      at = i;
      break;
    }
  }
  if (at < 0) return [];

  const out = [];
  for (let j = at + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    const m = l.match(/^\s{4}-\s*cron:\s*(.+?)\s*$/);
    if (!m) break;
    out.push(m[1].replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

/**
 * `jobs:` 아래 잡 이름 → 그 잡의 `if:` 문자열(없으면 null).
 * 잡 키는 들여쓰기 2칸, `if:` 는 4칸이라는 이 저장소의 관례를 그대로 읽는다.
 */
export function jobConditions(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return {};

  const out = {};
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    if (/^\S/.test(l)) break; // jobs: 블록 종료

    const job = l.match(/^\s{2}([A-Za-z0-9_-]+):\s*$/);
    if (job) {
      current = job[1];
      out[current] = null;
      continue;
    }
    const cond = l.match(/^\s{4}if:\s*(.+?)\s*$/);
    if (cond && current) out[current] = cond[1];
  }
  return out;
}

/** 잡의 `if:` 가 schedule 실행을 배제하는가. */
export function skipsSchedule(cond) {
  if (!cond) return false;
  return /github\.event_name\s*!=\s*'schedule'/.test(cond);
}

// audit-ci-branch-coverage.mjs 와 같은 이유로 직접 실행일 때만 검사한다 — import
// 만으로 process.exit(1) 이 돌면 테스트 러너 전체가 죽어서 "가드 FAIL" 이 아니라
// "스위트가 통째로 죽음" 으로 보인다.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

function main() {
  if (!existsSync(CI_YML)) {
    console.error('FAIL .github/workflows/ci.yml 이 없다 — 정기 감사의 근거가 사라졌다.');
    process.exit(1);
  }
  const yaml = readFileSync(CI_YML, 'utf8');
  const failures = [];

  const crons = scheduleCrons(yaml);
  if (crons.length === 0) {
    console.log('FAIL ci.yml 에 schedule 트리거가 없다 — 정기 재감사가 돌지 않는다');
    failures.push(
      'ci.yml `on:` 에 `schedule: - cron: ...` 이 없다. 이벤트 구동 트리거만 남으면' +
        ' 의존성을 건드리는 다음 push 까지 새 advisory 를 아무도 보지 않는다.',
    );
  } else {
    for (const c of crons) console.log(`ok   schedule cron '${c}' — 정기 재감사 살아 있음`);
  }

  const conditions = jobConditions(yaml);
  const jobNames = Object.keys(conditions);
  if (jobNames.length === 0) {
    console.error('FAIL ci.yml 의 jobs 를 하나도 파싱하지 못했다 — 가드가 침묵 통과한다.');
    process.exit(1);
  }

  for (const name of jobNames) {
    if (CRON_ONLY_JOBS.includes(name)) {
      console.log(`ok   ${name} — cron 에서 의도적으로 실행되는 잡`);
      continue;
    }
    if (skipsSchedule(conditions[name])) {
      console.log(`ok   ${name} — schedule 실행에서 스킵됨`);
    } else {
      console.log(`FAIL ${name} — schedule 스킵 조건이 없다`);
      failures.push(
        `잡 \`${name}\` 의 \`if:\` 에 \`github.event_name != 'schedule'\` 이 없다 —` +
          ' cron 이 이 잡을 매일 태운다.',
      );
    }
  }

  if (failures.length > 0) {
    console.error(
      `\n정기 감사 커버리지 문제 ${failures.length}건:\n` +
        failures.map((f) => `  - ${f}`).join('\n') +
        `\n\ncron 이 태울 것은 lockfile 만 읽는 dependency-audit 하나뿐이다.` +
        ` 새 잡을 cron 에서도 돌리려는 의도라면 이 스크립트의 CRON_ONLY_JOBS 에` +
        ` 추가할 것 — 자세한 이유는 scripts/audit-cron-coverage.mjs 상단 참고.`,
    );
    process.exit(1);
  }

  console.log(`\n잡 ${jobNames.length}개 — cron 은 dependency-audit 만 태운다.`);
}
