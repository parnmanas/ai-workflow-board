// Runtime Host 에 설치된 CLI 의 "설치 버전 vs 최신 버전" 판정 — Update 버튼을
// 활성으로 둘지 잠글지를 가르는 한 곳.
//
// 매니저는 두 맵을 하트비트로 싣는다: `cli_versions`(각 CLI 의 `--version`)와
// `cli_latest_versions`(npm 레지스트리의 latest). **키 부재는 "최신" 이 아니라
// "모름"** 이다 — 최신을 확인하지 못한 CLI 의 버튼을 잠그면, 운영자는 올릴 게
// 있는데도 올릴 수 없다. 그래서 판정은 삼항이다: up-to-date / outdated / unknown.
//
// 버전 문자열은 CLI 마다 장식이 다르다(`2.1.281 (Claude Code)`, `codex-cli 0.153.4`).
// 비교 전에 semver 코어만 벗겨 쓰고, 못 벗기면 비교를 포기한다.

export type CliUpdateState = 'up-to-date' | 'outdated' | 'unknown';

/** `--version` 출력에서 semver 코어(`major.minor.patch`)만 뽑는다. 못 찾으면 null
 *  — "0.0.0 으로 치자" 는 잘못된 비교를 만든다. */
export function extractSemver(version: string | null | undefined): string | null {
  if (!version) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.split('.').map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((aa[i] ?? 0) !== (bb[i] ?? 0)) return (aa[i] ?? 0) < (bb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/**
 * 설치 버전과 최신 버전을 견준다. 어느 한쪽이 없거나 semver 를 못 뽑으면
 * 'unknown' — 호출자는 그때 버튼을 **잠그지 않는다**.
 *
 * 설치 버전이 최신보다 앞선 경우(dist-tag 보다 앞서 나간 nightly 등)도
 * 'up-to-date' 다: 올릴 게 없다는 뜻은 같다.
 */
export function cliUpdateState(
  installed: string | null | undefined,
  latest: string | null | undefined,
): CliUpdateState {
  const a = extractSemver(installed);
  const b = extractSemver(latest);
  if (!a || !b) return 'unknown';
  return compareSemver(a, b) < 0 ? 'outdated' : 'up-to-date';
}
