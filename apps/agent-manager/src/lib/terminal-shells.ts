// Terminal(Runtime Host 셸) — 이 장비에서 띄울 수 있는 셸을 찾는다.
//
// 하트비트의 `terminal_shells` 가 곧 AWB 화면의 셸 선택지이고, **비어 있으면 그 장비는
// 터미널 목록에 아예 나오지 않는다**. 그래서 여기서 찾지 못한 셸은 사용자에게 "눌러도
// 열리지 않는 선택지" 가 되지 않는다.

import { access, constants as fsConstants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

import { findOnPath } from './find-on-path.js';

export interface TerminalShell {
  id: string;
  label: string;
  path: string;
  /** 아무것도 고르지 않았을 때 쓰는 셸. 목록에 정확히 하나 있다. */
  default?: boolean;
}

interface ShellCandidate {
  id: string;
  label: string;
  /** PATH 에서 찾을 실행 파일 이름들(앞의 것이 우선). */
  names: string[];
  /** PATH 에 없을 때 시도할 절대 경로. */
  paths?: string[];
}

const POSIX_CANDIDATES: ShellCandidate[] = [
  { id: 'bash', label: 'bash', names: ['bash'], paths: ['/bin/bash', '/usr/bin/bash', '/opt/homebrew/bin/bash'] },
  { id: 'zsh', label: 'zsh', names: ['zsh'], paths: ['/bin/zsh', '/usr/bin/zsh', '/opt/homebrew/bin/zsh'] },
  { id: 'fish', label: 'fish', names: ['fish'], paths: ['/usr/bin/fish', '/opt/homebrew/bin/fish'] },
  { id: 'sh', label: 'sh', names: ['sh'], paths: ['/bin/sh'] },
];

const WINDOWS_CANDIDATES: ShellCandidate[] = [
  { id: 'pwsh', label: 'PowerShell 7', names: ['pwsh'] },
  {
    id: 'powershell',
    label: 'Windows PowerShell',
    names: ['powershell'],
    paths: [`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`],
  },
  { id: 'cmd', label: 'Command Prompt', names: ['cmd'], paths: [process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe'] },
  { id: 'git-bash', label: 'Git Bash', names: [], paths: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'] },
];

async function isExecutable(path: string): Promise<boolean> {
  if (!path || !isAbsolute(path)) return false;
  try {
    await access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCandidate(candidate: ShellCandidate): Promise<string | null> {
  for (const name of candidate.names) {
    const found = await findOnPath(name);
    if (found) return found;
  }
  for (const path of candidate.paths || []) {
    if (await isExecutable(path)) return path;
  }
  return null;
}

/**
 * 이 장비의 셸 목록. 기본 셸은 Windows 면 `COMSPEC`/PowerShell, POSIX 면 `$SHELL` 을
 * 우선한다 — 운영자가 터미널에서 쓰던 셸과 같은 것을 주는 편이 덜 놀랍다.
 */
export async function detectTerminalShells(): Promise<TerminalShell[]> {
  const windows = process.platform === 'win32';
  const candidates = windows ? WINDOWS_CANDIDATES : POSIX_CANDIDATES;
  const shells: TerminalShell[] = [];
  for (const candidate of candidates) {
    const path = await resolveCandidate(candidate);
    if (!path) continue;
    shells.push({ id: candidate.id, label: candidate.label, path });
  }

  // 운영자의 로그인 셸이 위 후보에 없을 수도 있다(nushell, elvish …). 있으면 그대로 싣는다.
  const preferred = windows ? process.env.COMSPEC : process.env.SHELL;
  if (preferred && await isExecutable(preferred)) {
    const known = shells.find((s) => s.path.toLowerCase() === preferred.toLowerCase());
    if (known) {
      known.default = true;
    } else {
      const base = preferred.split(/[\\/]/).pop() || 'shell';
      const id = base.replace(/\.exe$/i, '').toLowerCase().replace(/[^a-z0-9._+-]/g, '-') || 'login-shell';
      if (!shells.some((s) => s.id === id)) {
        shells.unshift({ id, label: `${base} (login shell)`, path: preferred, default: true });
      }
    }
  }
  if (shells.length && !shells.some((s) => s.default)) shells[0].default = true;
  return shells;
}

/** 새 터미널의 기본 작업 폴더 — 아무것도 안 고르면 운영자의 홈. */
export function defaultTerminalCwd(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir() || process.cwd();
}
