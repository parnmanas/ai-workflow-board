// 한 CLI **설치본**이 어떤 방법으로 깔렸는지 알아내고, 그 설치본을 올리는
// 정확한 명령을 만든다.
//
// 왜 "CLI 별"이 아니라 "설치본 별"인가: 한 호스트에 같은 CLI 가 여러 벌 있는
// 것은 정상 구성이다. ragnar 는 vLLM 백엔드용으로 claude 를 두 벌 두고
// (`~/.local` prefix 와 nvm prefix), runtime profile 의 `claude_executable` 로
// 어느 설치본을 쓸지 고른다. 그러므로 "이 장비의 claude 를 올린다" 는 말은
// 애매하고, 올릴 대상은 항상 **경로**다.
//
// 왜 CLI 자체 업데이터만으로는 부족한가: `claude update` 는 자기 자신이 아니라
// **PATH 위의 npm 이 가리키는 prefix** 로 설치한다. ragnar 실측에서 우리가 쓰는
// `~/.local/bin/claude`(2.1.273)를 통해 업데이트를 돌렸더니 새 버전이
// `~/.nvm/.../bin/claude` 에 깔리고 exit 0 으로 끝났다 — 손댄 적 없는 다른
// 설치본이 올라갔고, 정작 대상은 그대로였다. 설치 레이아웃에서 prefix 를 직접
// 읽어 `npm --prefix <prefix>` 로 박아야 "누른 그것" 이 올라간다.
//
// 판정은 전부 **디스크에 남은 증거**로만 한다(심링크 대상의 실제 경로). 추측이
// 서지 않으면 `unknown` 을 내고 호출자가 CLI 자체 업데이터로 넘어가게 한다 —
// 틀린 prefix 로 npm 을 돌리는 것보다 낫다.

import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import { posix, sep, win32 } from 'node:path';

/** 설치 방법. `manual` 은 "우리가 올릴 수 없다" 는 뜻이고, 그때는 운영자가
 *  직접 돌릴 명령을 `manualCommand` 로 그대로 알려준다. */
export type InstallMethodKind =
  | 'npm-prefix'
  | 'bun'
  | 'volta'
  | 'pnpm'
  | 'snap'
  | 'homebrew'
  | 'native'
  | 'unknown';

export interface InstallMethod {
  kind: InstallMethodKind;
  /** 이 설치본을 **현재 사용자 권한으로** 올리는 명령. null 이면 그 권한으로는
   *  올릴 수 없다는 뜻이다(`elevatedArgv`/`manualCommand`/CLI 자체 업데이터로 넘어간다). */
  argv: { cmd: string; args: string[] } | null;
  /** 같은 일을 **root 로** 하는 명령. 운영자가 비밀번호를 준 경우에만 쓰인다.
   *  `argv` 가 있으면 여기는 null 이다 — 안 올려도 되는 권한을 올리지 않는다.
   *
   *  Homebrew 는 의도적으로 null 이다: brew 는 root 로 실행하는 것을 스스로
   *  거부하고, 억지로 돌리면 설치 트리의 소유권이 망가진다. 권한 상승이 답이
   *  아닌 경우까지 "sudo 하면 된다" 로 뭉뚱그리면 안 된다. */
  elevatedArgv: { cmd: string; args: string[] } | null;
  /** 사람이 읽는 한 줄 설명 — ack 와 UI 에 그대로 실린다. */
  label: string;
  /** 우리가 못 돌리는 경우 운영자가 직접 칠 명령(권한 상승이 필요한 경우 포함). */
  manualCommand: string | null;
  /** 설치 루트. npm-prefix 일 때만 의미가 있다. */
  prefix: string | null;
  /** 설치 루트에 쓰기 권한이 없다 — 돌려도 EACCES 로 죽으므로 시도하지 않는다. */
  needsElevation: boolean;
}

export interface InstallMethodProbes {
  /** 심링크까지 푼 실제 경로. 기본은 fs.realpathSync. */
  realpath?: (p: string) => string;
  /** 쓰기 가능 여부. 기본은 fs.accessSync(W_OK). */
  writable?: (p: string) => boolean;
  /** 테스트/Windows 분기용. 기본은 현재 플랫폼. */
  windows?: boolean;
}

function defaultRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function defaultWritable(p: string): boolean {
  try {
    accessSync(p, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 경로 비교는 항상 `/` 로 정규화해서 한다 — 아래 마커들은 플랫폼과 무관하게
 *  같은 모양이고, Windows 의 `\` 때문에 매칭이 어긋나면 안 된다. */
function toPosix(p: string): string {
  return p.split(/[\\/]/).join('/');
}

/**
 * npm 트리에서 **패키지 이름**을 뽑는다. `…/node_modules/@scope/name/…` 은 두
 * 조각, `…/node_modules/name/…` 은 한 조각이다.
 *
 * 경로에서 읽는 편이 어댑터의 `updatePackage()` 보다 강하다: 그건 "이 CLI 는 보통
 * 이 패키지" 라는 선언이고, 이쪽은 **이 설치본이 실제로 무엇인지** 다. 어댑터가
 * 패키지를 선언하지 않은 CLI(pi 등)도 npm 으로 깔려 있기만 하면 이 경로로 올릴 수
 * 있게 된다.
 */
export function npmPackageFromRealPath(realPath: string): string | null {
  const parts = toPosix(realPath).split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return null;
  const first = parts[at + 1];
  if (!first) return null;
  if (first.startsWith('@')) {
    const second = parts[at + 2];
    return second ? `${first}/${second}` : null;
  }
  return first;
}

/**
 * `<prefix>/lib/node_modules/<pkg>/…`(POSIX·npm 기본) 또는
 * `<prefix>/node_modules/<pkg>/…`(Windows npm) 레이아웃에서 prefix 를 뽑는다.
 * 못 찾으면 null.
 */
export function npmPrefixFromRealPath(realPath: string, windows: boolean): string | null {
  const p = toPosix(realPath);
  const marker = windows ? '/node_modules/' : '/lib/node_modules/';
  const at = p.lastIndexOf(marker);
  if (at < 0) return null;
  const prefix = p.slice(0, at);
  if (!prefix) return null;
  // Windows 에서 `/lib/node_modules/` 도 함께 허용한다 — nvm-windows 처럼 POSIX
  // 레이아웃을 그대로 쓰는 설치가 있다. `lib` 꼬리가 남으면 벗긴다.
  const trimmed = prefix.endsWith('/lib') ? prefix.slice(0, -'/lib'.length) : prefix;
  return windows ? trimmed.split('/').join(win32.sep) : trimmed;
}

/**
 * 절대 경로 하나를 보고 설치 방법을 판정한다. `pkg` 는 어댑터의
 * `updatePackage()` — npm 계열 방법은 이 값이 있어야 명령을 만들 수 있다.
 */
export function detectInstallMethod(
  bin: string,
  pkgHint: string | null,
  probes: InstallMethodProbes = {},
): InstallMethod {
  const windows = probes.windows ?? process.platform === 'win32';
  const realpath = probes.realpath ?? defaultRealpath;
  const writable = probes.writable ?? defaultWritable;
  const real = toPosix(realpath(bin));
  const link = toPosix(bin);
  // 경로에서 읽어낸 패키지가 우선 — 어댑터의 선언보다 이 설치본에 관한 사실이다.
  const pkg = npmPackageFromRealPath(real) ?? pkgHint;

  const none = (
    kind: InstallMethodKind,
    label: string,
    manualCommand: string | null,
    elevatedArgv: { cmd: string; args: string[] } | null = null,
  ): InstallMethod => ({
    kind,
    argv: null,
    elevatedArgv,
    label,
    manualCommand,
    prefix: null,
    needsElevation: Boolean(elevatedArgv),
  });

  // snap / homebrew Cellar 는 우리 권한 밖이거나 formula 이름을 경로에서 신뢰성
  // 있게 유도할 수 없다. 추측해서 엉뚱한 것을 올리느니 정확한 명령을 알려준다.
  // 이름은 호출된 파일명에서 뽑는다 — realpath 는 `/snap/<name>/current/bin/...`
  // 처럼 중간 경로가 끼어 마지막 조각이 패키지 이름이 아닐 수 있다.
  const invokedName = (link.split('/').pop() ?? '').replace(/\.(exe|cmd|bat)$/i, '');
  if (real.startsWith('/snap/') || link.startsWith('/snap/')) {
    return none(
      'snap',
      'snap package',
      `sudo snap refresh ${invokedName || '<package>'}`,
      invokedName ? { cmd: 'snap', args: ['refresh', invokedName] } : null,
    );
  }
  if (real.includes('/Cellar/') || real.includes('/linuxbrew/')) {
    // brew 는 root 실행을 스스로 거부한다 — 권한 상승은 답이 아니라 새 고장이다.
    return none('homebrew', 'Homebrew formula', `brew upgrade ${invokedName || '<formula>'}`);
  }

  // volta / bun / pnpm 은 전역 설치를 각자의 저장소에 넣으므로, 일반 npm prefix
  // 규칙보다 **먼저** 본다 — bun 의 전역 트리에도 `node_modules` 가 들어 있다.
  if (real.includes('/.volta/') || link.includes('/.volta/')) {
    return pkg
      ? {
          kind: 'volta',
          argv: { cmd: 'volta', args: ['install', `${pkg}@latest`] },
          elevatedArgv: null,
          label: 'volta install',
          manualCommand: `volta install ${pkg}@latest`,
          prefix: null,
          needsElevation: false,
        }
      : none('volta', 'Volta-managed install', 'volta install <package>@latest');
  }
  if (real.includes('/.bun/') || link.includes('/.bun/')) {
    return pkg
      ? {
          kind: 'bun',
          argv: { cmd: 'bun', args: ['add', '-g', `${pkg}@latest`] },
          elevatedArgv: null,
          label: 'bun add -g',
          manualCommand: `bun add -g ${pkg}@latest`,
          prefix: null,
          needsElevation: false,
        }
      : none('bun', 'bun global install', 'bun add -g <package>@latest');
  }
  if (real.includes('/pnpm/')) {
    return pkg
      ? {
          kind: 'pnpm',
          argv: { cmd: 'pnpm', args: ['add', '-g', `${pkg}@latest`] },
          elevatedArgv: null,
          label: 'pnpm add -g',
          manualCommand: `pnpm add -g ${pkg}@latest`,
          prefix: null,
          needsElevation: false,
        }
      : none('pnpm', 'pnpm global install', 'pnpm add -g <package>@latest');
  }

  const prefix = npmPrefixFromRealPath(real, windows);
  if (prefix && pkg) {
    // prefix 에 쓸 수 없으면(예: 루트 소유의 /usr/local) 돌려 봐야 EACCES 다.
    // 매니저가 sudo 를 쓰는 일은 없다 — 명령만 정확히 알려준다.
    const root = windows ? `${prefix}${win32.sep}node_modules` : posix.join(prefix, 'lib', 'node_modules');
    const canWrite = writable(root);
    const manual = `npm --prefix ${prefix} install -g ${pkg}@latest`;
    const npmArgv = { cmd: 'npm', args: ['--prefix', prefix, 'install', '-g', `${pkg}@latest`] };
    return {
      kind: 'npm-prefix',
      argv: canWrite ? npmArgv : null,
      // 쓸 수 없는 prefix 는 root 로는 올릴 수 있다 — 운영자가 비밀번호를 준 경우에만.
      elevatedArgv: canWrite ? null : npmArgv,
      label: `npm --prefix ${prefix}`,
      manualCommand: canWrite ? manual : `sudo ${manual}`,
      prefix,
      needsElevation: !canWrite,
    };
  }
  if (prefix && !pkg) {
    // prefix 는 찾았는데 패키지 이름을 못 읽었다 — 레이아웃이 npm 같기는 하나
    // 무엇을 재설치해야 하는지 모른다. 추측해서 엉뚱한 패키지를 깔지 않는다.
    return none('npm-prefix', `npm install under ${prefix} (package name unknown)`, null);
  }

  // node_modules 아래가 아닌 단일 실행 파일 — Claude Code 의 native installer 나
  // curl 설치 스크립트가 이 모양이다. 이런 설치는 CLI 자체 업데이터가 자기
  // 레이아웃을 알고 제자리에서 갈아 끼우므로, 그쪽에 맡기는 것이 맞다.
  if (/\/\.local\/(bin|share)\//.test(real) || /\/\.local\/(bin|share)\//.test(link)) {
    return none('native', 'native installer (self-updater)', null);
  }
  return none('unknown', 'unrecognised install layout', null);
}

/** 사람이 읽는 한 줄 — ack·UI·로그가 같은 문구를 쓰게 한다. */
export function describeInstallMethod(method: InstallMethod): string {
  if (method.needsElevation && method.elevatedArgv) {
    return `${method.label} (needs sudo)`;
  }
  if (method.needsElevation && method.manualCommand) {
    return `${method.label} (write-protected — run: ${method.manualCommand})`;
  }
  if (!method.argv && method.manualCommand) {
    return `${method.label} (run: ${method.manualCommand})`;
  }
  return method.label;
}

/** 경로 구분자 차이를 흡수한 표시용 정규화 — 로그/ack 의 경로를 한 모양으로. */
export function displayPath(p: string): string {
  return sep === '\\' ? p.split('/').join('\\') : p;
}
