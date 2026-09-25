// ticket 06b2b990 — Claude CLI device-auth 자동 로그인.
//
// `claude auth login --claudeai` 를 격리된 CLAUDE_CONFIG_DIR 에서 돌린다.
// claude 2.1.x 출력 예:
//   Opening browser to sign in…
//   If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?...
//   Paste code here if prompted >
//
// claude 는 codex 와 달리 사용자가 브라우저 밖에서 입력할 one-time code 가 없다 —
// verification_url 을 여는 것 자체가 승인 흐름의 전부이고, 이후 완료 여부는 claude
// CLI 자신이 백그라운드에서 폴링해 감지한다("Paste code here if prompted" 는 자동
// 폴링이 실패했을 때만 쓰이는 조건부 폴백이라 릴레이 대상이 아니다). 그래서 URL 을
// 찾는 즉시 awaiting_user 를 보고한다.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CliLoginSpec } from '../cli-module.js';

export const claudeLogin: CliLoginSpec = {
  harvestProvider: 'claude_subscription',

  plan({ homeDir }) {
    return {
      spawnArgs: ['auth', 'login', '--claudeai'],
      env: { CLAUDE_CONFIG_DIR: homeDir },
    };
  },

  createLineParser() {
    let urlCaptured = false;
    return (line) => {
      if (urlCaptured) return null;
      const urlMatch = line.match(/https?:\/\/\S+/);
      if (!urlMatch) return null;
      urlCaptured = true;
      return { verification_url: urlMatch[0] };
    };
  },

  async harvest(homeDir) {
    let credentialsJson: string;
    try {
      credentialsJson = await readFile(join(homeDir, '.credentials.json'), 'utf8');
    } catch (err: any) {
      throw new Error(
        `claude auth login exited 0 but .credentials.json was not found in the isolated CLAUDE_CONFIG_DIR: ${err?.message ?? err}`,
      );
    }
    return { credentials_json: credentialsJson };
  },
};
