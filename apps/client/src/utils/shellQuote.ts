/**
 * argv 토큰을 POSIX 셸에 안전하게 인용한다 — ticket 20fff298 (리뷰 2R).
 *
 * ## 왜 필요한가
 *
 * 이전 구현은 **공백이 있을 때만** `JSON.stringify` 로 감쌌고 실행 파일 경로는
 * 아예 인용하지 않았다. 두 가지가 잘못이었다:
 *
 *   1. 공백이 없는 토큰은 그대로 나가므로 `$(…)`, 백틱, `$VAR`, `;`, `|`, `&`
 *      같은 셸 메타문자가 **붙여넣는 순간 확장·실행**된다.
 *   2. `JSON.stringify` 는 큰따옴표를 쓴다. POSIX 셸의 큰따옴표 안에서는 `$` 와
 *      백틱이 여전히 확장되므로 감싸도 막지 못한다.
 *
 * 그래서 **홑따옴표**로 감싼다. 홑따옴표 안에서는 어떤 문자도 특수 의미를
 * 갖지 않는다. 홑따옴표 자체만 `'\''` 로 끊어 이어 붙인다.
 *
 * ## 인용을 생략하는 경우
 *
 * 셸 메타문자가 될 수 없는 문자로만 이뤄진 토큰은 그대로 둔다 — 명령 전체가
 * 홑따옴표로 덮이면 사람이 읽기 어렵기 때문이다. 허용 집합은 **allowlist** 이므로
 * 새로운 특수문자가 조용히 통과하는 일이 없다.
 */

/** 셸에서 특수 의미가 없는 문자만. allowlist 이므로 미지의 문자는 인용된다. */
const SHELL_SAFE_BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX 셸 홑따옴표 인용. */
export function posixShellQuote(token: string): string {
  if (token === '') return "''";
  if (SHELL_SAFE_BARE.test(token)) return token;
  return `'${token.split("'").join(`'\\''`)}'`;
}

/**
 * 실행 파일과 argv 를 POSIX 셸 한 줄로 만든다. **bin 도 인용 대상이다** —
 * 공백이 든 설치 경로(`/opt/My Tools/claude`)가 두 토큰으로 쪼개지던 버그가
 * 실행 파일 자리에서 났다.
 */
export function posixCommandLine(bin: string, args: readonly string[]): string {
  return [bin, ...args].map(posixShellQuote).join(' ');
}

/**
 * 이식성이 가장 높은 복사 형태 — argv JSON 배열.
 *
 * 셸 문법이 전혀 없으므로 어떤 셸·어떤 OS 에서도 재해석될 여지가 없고, 토큰
 * 경계가 모호해지지 않는다. 화면의 한 줄 명령은 읽기용이고, 기계로 옮길 때는
 * 이 형태가 정답이다.
 */
export function argvJson(bin: string, args: readonly string[]): string {
  return JSON.stringify([bin, ...args], null, 2);
}
