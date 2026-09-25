// ticket b2e79108 — Codex CLI device-auth 자동 로그인.
//
// `codex login --device-auth` 를 격리된 CODEX_HOME 에서 돌린다. codex 0.11x 출력 예:
//   Welcome to Codex [v0.116.0]
//   Follow these steps to sign in:
//   1. Open this link in your browser: https://auth.openai.com/codex/device
//   2. Enter this one-time code: ABCD-EFGH-IJKL
//   Waiting for authorization...
//
// 버전업 시 문구가 바뀔 수 있으므로 파싱은 정확한 코드 포맷이 아니라 주변 영문 안내
// 문구("Enter this one-time code")나 URL 자체의 등장에 기댄다. 코드는 안내 문구 **다음
// 줄**에 온다 — URL 만으로는 보고하지 않고 코드까지 받은 뒤 한 번에 보고한다.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CliLoginSpec } from '../cli-module.js';

export const codexLogin: CliLoginSpec = {
  harvestProvider: 'codex_subscription',

  plan({ homeDir }) {
    return {
      spawnArgs: ['login', '--device-auth'],
      env: { CODEX_HOME: homeDir },
    };
  },

  createLineParser() {
    let capturedUrl = '';
    let expectCodeNext = false;
    return (line) => {
      if (expectCodeNext) {
        expectCodeNext = false;
        return { verification_url: capturedUrl, user_code: line };
      }
      if (!capturedUrl) {
        const urlMatch = line.match(/https?:\/\/\S+/);
        if (urlMatch) capturedUrl = urlMatch[0];
      }
      if (/enter this one-time code/i.test(line)) expectCodeNext = true;
      return null;
    };
  },

  async harvest(homeDir) {
    let authJson: string;
    try {
      authJson = await readFile(join(homeDir, 'auth.json'), 'utf8');
    } catch (err: any) {
      throw new Error(`codex login exited 0 but auth.json was not found in the isolated CODEX_HOME: ${err?.message ?? err}`);
    }
    let configToml = '';
    try {
      configToml = await readFile(join(homeDir, 'config.toml'), 'utf8');
    } catch {
      // config.toml is optional for codex_subscription — only auth_json is required.
    }
    const fields: Record<string, string> = { auth_json: authJson };
    if (configToml) fields.config_toml = configToml;
    return fields;
  },
};
