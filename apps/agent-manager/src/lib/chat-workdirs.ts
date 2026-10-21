// 채팅 전용 작업 폴더 — 새 채팅에서 Agent 의 작업 폴더를 비워 두면 화면이
// `<CHAT_WORKDIR_ROOT>/<이름>` 을 채운다(docs/chat.md "Agent participants and their working folder").
//
// 채팅 Agent 도 티켓·미션과 같은 RuntimeSpec(Host + CLI + 작업 폴더)이라 폴더는 여전히 CLI 의
// cwd 이자 실행 신원(cli + 폴더 + credential)의 일부다. 다만 "그냥 대화하려는" Agent 에게
// 프로젝트 폴더를 고르게 할 이유는 없으므로, 이 장비의 빈 전용 폴더를 기본값으로 쓴다 —
// 운영자 홈을 기본값으로 두면 Codex 쓰기 범위·Claude 신뢰 범위가 홈 전체가 된다.
//
// 루트는 하트비트 `chat_workdir_root` 로 서버에 알린다. 그 아래 폴더는 디스패치 때 매니저가
// 만든다(사용자가 고른 다른 폴더는 만들지 않는다 — 없는 폴더는 그 사용자의 실수다).

import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AGENT_MANAGER_HOME } from './constants.js';

export const CHAT_WORKDIR_ROOT = join(AGENT_MANAGER_HOME, 'chat-workdirs');

/** dir 가 root 아래(root 자신 제외)인가. `..` 로 빠져나가는 경로는 아니다. */
export function isUnderChatWorkdirRoot(dir: string, root = CHAT_WORKDIR_ROOT): boolean {
  if (!dir || !isAbsolute(dir)) return false;
  const rel = relative(resolve(root), resolve(dir));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/** 채팅 전용 루트 아래 경로면 만들어 둔다(멱등). 만들었거나 이미 있으면 true, 대상이 아니면 false. */
export async function ensureChatWorkdir(dir: string | null | undefined, root = CHAT_WORKDIR_ROOT): Promise<boolean> {
  const target = (dir || '').trim();
  if (!isUnderChatWorkdirRoot(target, root)) return false;
  await mkdir(resolve(target), { recursive: true, mode: 0o700 });
  return true;
}
