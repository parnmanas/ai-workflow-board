// opencode provider 단위 device-auth 로그인.
//
// opencode 1.18.32, 격리 XDG_DATA_HOME (`opencode auth login -p openai
// -m "ChatGPT Pro/Plus (headless)"`):
//   ┌  Add credential
//   ●  Go to: https://auth.openai.com/codex/device
//   ●  Enter code: WZ1E-3RVM7
//   ◒  Waiting for authorization
//
// 웹 승인이 되는 조합만 자동화 대상이다 — API key 를 붙여넣는 provider(anthropic/
// google/opencode zen)는 TTY 프롬프트라 여기서 다루지 않는다(붙여넣기는 Credentials
// 화면에서 직접 등록하는 편이 빠르다).
//
// 코드가 URL 다음 **줄**에 오는 codex 와 달리 opencode 는 같은 줄에 `Enter code: XXXX`
// 로 싣는다. URL 을 찾는 즉시 한 번, 코드까지 찾으면 다시 한 번 awaiting_user 를
// 보고한다 — 서버는 온 필드만 각각 반영한다. provider 조합에 따라 코드가 아예 없을
// 수도 있고, 그때도 사용자는 링크만 있으면 승인할 수 있다.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CliLoginSpec } from '../cli-module.js';

export const opencodeLogin: CliLoginSpec = {
  harvestProvider: 'opencode_auth',
  providerScoped: true,

  plan({ homeDir, cliProvider, cliMethod }) {
    const provider = (cliProvider || '').trim();
    const method = (cliMethod || '').trim();
    // 둘 중 하나라도 비면 opencode 는 선택 UI 를 띄우려 한다 — 파이프 뒤에서는
    // 아무것도 출력하지 않고 그대로 멎어(실측) 10분 타임아웃까지 "starting" 에
    // 갇힌다. 서버도 막지만 여기서도 막아 둔다(직접 호출·구버전 서버 대비).
    if (!provider || !method) {
      throw new Error('opencode login requires both cli_provider and cli_method (e.g. openai / "ChatGPT Pro/Plus (headless)")');
    }
    // opencode 는 CODEX_HOME/CLAUDE_CONFIG_DIR 같은 단일 홈 변수가 없고 XDG 로
    // 흩어진다. 그래서 네 XDG 축을 전부 격리 홈 아래로 고정한다 — HOME 만 바꾸면
    // Windows 에서 `os.homedir()` 가 USERPROFILE 이라 운영자 상태를 그대로
    // 읽는다(같은 함정을 에이전트 홈에서 이미 밟았다: XDG_CONFIG_HOME 참고).
    // HOME 도 함께 넘기는 것은 XDG 를 안 보는 경로(플러그인 등)의 보험이다.
    return {
      spawnArgs: ['auth', 'login', '-p', provider, '-m', method],
      env: {
        HOME: homeDir,
        XDG_DATA_HOME: join(homeDir, 'data'),
        XDG_CONFIG_HOME: join(homeDir, 'config'),
        XDG_CACHE_HOME: join(homeDir, 'cache'),
        XDG_STATE_HOME: join(homeDir, 'state'),
      },
    };
  },

  createLineParser() {
    let capturedUrl = '';
    let codeSent = false;
    return (line) => {
      if (!capturedUrl) {
        const urlMatch = line.match(/https?:\/\/\S+/);
        if (urlMatch) {
          capturedUrl = urlMatch[0];
          // 같은 줄에 코드까지 있는 경우는 아래에서 한 번에 보고한다.
          const sameLineCode = line.match(/enter\s+(?:this\s+)?(?:one-time\s+)?code:\s*(\S+)/i);
          if (sameLineCode && !codeSent) {
            codeSent = true;
            return { verification_url: capturedUrl, user_code: sameLineCode[1] };
          }
          return { verification_url: capturedUrl };
        }
      }
      const codeMatch = line.match(/enter\s+(?:this\s+)?(?:one-time\s+)?code:\s*(\S+)/i);
      if (codeMatch && !codeSent) {
        codeSent = true;
        return { ...(capturedUrl ? { verification_url: capturedUrl } : {}), user_code: codeMatch[1] };
      }
      return null;
    };
  },

  async harvest(homeDir) {
    // provider 가 무엇이든 수확물은 이 파일 하나다 — 격리 XDG_DATA_HOME 아래의
    // `opencode/auth.json`. 어느 provider 로 로그인했는지는 파일 자신이 안다.
    const authPath = join(homeDir, 'data', 'opencode', 'auth.json');
    let authJson: string;
    try {
      authJson = await readFile(authPath, 'utf8');
    } catch (err: any) {
      throw new Error(
        `opencode auth login exited 0 but auth.json was not found in the isolated XDG_DATA_HOME: ${err?.message ?? err}`,
      );
    }
    return { auth_json: authJson };
  },
};
