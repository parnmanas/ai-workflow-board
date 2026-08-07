import { runCapturedCommand } from '../probe-command.js';

export interface HermesAcpCommand {
  command: string;
  argsPrefix: string[];
}

// 일부 Hermes 설치본은 전용 `hermes-acp` 래퍼 바이너리를 제공하고, 다른 설치본은
// `acp` 서브커맨드를 쓰는 단일 `hermes` 바이너리만 있다. 프로세스당 1회 해석해
// 캐시한다 — 두 형태 모두 장기적으로 유효하므로 매 agent spawn마다 재프로브할
// 이유가 없다.
let cachedAcpCommand: Promise<HermesAcpCommand> | null = null;

export async function resolveHermesAcpCommand(): Promise<HermesAcpCommand> {
  const override = process.env.HERMES_ACP_COMMAND?.trim();
  if (override) return { command: override, argsPrefix: [] };
  if (!cachedAcpCommand) {
    cachedAcpCommand = (async () => {
      const direct = await runCapturedCommand('hermes-acp', ['--help']);
      if (direct.installed) return { command: 'hermes-acp', argsPrefix: [] };
      return { command: 'hermes', argsPrefix: ['acp'] };
    })();
  }
  return cachedAcpCommand;
}

/** 테스트 전용: 캐시된 해석 결과를 지워 새 PATH/env 기준으로 다시 프로브할 수 있게 한다. */
export function resetHermesAcpCommandCache(): void {
  cachedAcpCommand = null;
}

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * `hermes profile list`의 표 형식 출력을 파싱한다:
 *
 *  Profile          Model         Gateway    Alias   Distribution
 *  ───────────────  ────────────  ─────────  ──────  ────────────
 *  ◆default         gpt-5.6-sol   stopped    —       —
 *
 * `default`는 제외한다 — AWB는 이미 "프로파일 미선택"(runtime_config.profile
 * 미설정)을 Hermes 자체의 default로 취급하므로, 이를 목록에도 넣으면
 * "비워두기"의 중복 별칭일 뿐이다.
 */
export function parseHermesProfileList(output: string): string[] {
  const names = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^[─-╿\s]+$/.test(line)) continue; // 박스 문자 구분선 행
    const firstToken = line.replace(/^◆\s*/, '').split(/\s+/)[0];
    if (!firstToken) continue;
    const lower = firstToken.toLowerCase();
    if (lower === 'profile' || lower === 'default') continue;
    if (!PROFILE_NAME_RE.test(firstToken)) continue;
    names.add(lower);
  }
  return Array.from(names);
}

/**
 * discovery/heartbeat 프로브를 위해 Hermes 프로파일을 열거한다. 항상 `[]`로
 * degrade하며 절대 throw하지 않는다 — 깨졌거나 없는 `hermes` 바이너리가
 * hermes 런타임 행을 unhealthy로 뒤집으면 안 된다(그 판정은 주 `--help`
 * 프로브만의 몫이다).
 */
export async function listHermesProfiles(): Promise<string[]> {
  try {
    const result = await runCapturedCommand('hermes', ['profile', 'list']);
    if (!result.installed || !result.healthy) return [];
    return parseHermesProfileList(result.output);
  } catch {
    return [];
  }
}
