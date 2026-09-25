// PATH 에서 실행 파일을 찾는 leaf 유틸. spawn 없이 존재 여부만 본다 — 하트비트의
// `acp_session_clis` 판정과 ACP 어댑터 명령 해석이 같은 함수를 쓴다.

import { access, constants as fsConstants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export async function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const candidates = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      try {
        await access(full, fsConstants.X_OK);
        return full;
      } catch {
        /* next */
      }
    }
  }
  return null;
}
