// snap 설치본의 "이 채널 기준 최신" 을 읽는다.
//
// 왜 필요한가: `snap refresh <name>` 은 **추적 중인 채널 안에서만** 올린다. 그
// 채널이 멈춰 있으면 refresh 는 "올릴 것 없음" 으로 exit 0 이고, 그걸 그대로
// "이미 최신" 이라고 말하면 거짓말이 된다 — rolf 실측: `/snap/bin/codex` 는
// latest/stable 이 0.114.0(2026-03-14)에서 멈춘 비공식 패키지인데, 같은 호스트의
// 공식 npm 판은 0.156.1 이다. 채널의 최신을 모르면 화면은 "성공했다" 고 말하면서
// 버전은 그대로고 버튼은 계속 눌리는, 아무 데도 닿지 않는 상태가 된다.
//
// npm 의 latest 를 들이대는 것도 답이 아니다(다른 배포 채널의 숫자다). 그래서
// **그 채널의 최신**을 직접 읽는다. 이 값이 설치 버전과 같으면 "이 채널 기준으로는
// 최신" 이 참이고, 화면은 정직하게 버튼을 잠글 수 있다.

import crossSpawn from 'cross-spawn';

/** `snap info` 한 번의 상한. 로컬 데몬 조회지만 네트워크를 탈 수도 있다. */
export const SNAP_INFO_TIMEOUT_MS = 20_000;

export interface SnapChannelInfo {
  /** 현재 추적 중인 채널 (`latest/stable` 등). */
  tracking: string | null;
  /** 그 채널이 지금 제공하는 버전. 못 읽었으면 null. */
  latest: string | null;
}

/**
 * `snap info <name>` 출력에서 추적 채널과 그 채널의 버전을 뽑는다.
 *
 * 채널 목록의 `^` 는 "바로 위 채널과 같음" 을 뜻한다(snap 의 표기) — 그래서
 * 위에서부터 훑으며 마지막으로 본 구체적인 버전을 물려준다. 이걸 빠뜨리면
 * candidate/beta 를 추적하는 설치본의 최신을 영영 못 읽는다.
 *
 * 순수 함수 — 실제 snap 없이 전수 테스트한다.
 */
export function parseSnapInfo(output: string): SnapChannelInfo {
  let tracking: string | null = null;
  const versions = new Map<string, string>();
  let inChannels = false;
  let inherited: string | null = null;

  for (const raw of output.split(/\r?\n/)) {
    const trackMatch = /^tracking:\s*(\S+)/.exec(raw);
    if (trackMatch) {
      tracking = trackMatch[1];
      continue;
    }
    if (/^channels:/.test(raw)) {
      inChannels = true;
      continue;
    }
    if (inChannels) {
      // 채널 줄은 반드시 들여쓰기돼 있다. 들여쓰기가 끝나면 목록도 끝이다.
      if (!/^\s/.test(raw) && raw.trim()) break;
      const m = /^\s+(\S+):\s*(\S+)/.exec(raw);
      if (!m) continue;
      const [, channel, value] = m;
      if (value === '^') {
        if (inherited) versions.set(channel, inherited);
      } else {
        inherited = value;
        versions.set(channel, value);
      }
    }
  }

  const latest = tracking ? versions.get(tracking) ?? null : null;
  return { tracking, latest };
}

export interface SnapChannelDeps {
  /** `snap info <name>` 실행. 테스트가 갈아끼운다. */
  run?: (name: string) => Promise<string | null>;
}

function defaultRun(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = crossSpawn('snap', ['info', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    let out = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null);
    }, SNAP_INFO_TIMEOUT_MS);
    child.stdout?.on('data', (b) => {
      out += String(b);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? out : null));
  });
}

/**
 * 추적 중인 채널의 최신 버전. 실패하면 null — 그리고 null 은 "최신이다" 가 아니라
 * **"모른다"** 다. 호출자는 모를 때 버튼을 잠그면 안 된다.
 */
export async function readSnapChannelLatest(
  name: string,
  deps: SnapChannelDeps = {},
): Promise<SnapChannelInfo> {
  if (!name) return { tracking: null, latest: null };
  const run = deps.run ?? defaultRun;
  const output = await run(name).catch(() => null);
  return output ? parseSnapInfo(output) : { tracking: null, latest: null };
}
