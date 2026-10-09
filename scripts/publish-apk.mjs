#!/usr/bin/env node
/**
 * publish-apk.mjs — APK를 자료실에 올린다. 사이트의 "Android 앱 받기" 버튼은
 * kind='app' 중 최신본을 가리키므로, 올리면 버튼이 곧바로 새 버전을 낸다.
 *
 * 흐름: 로그인 → raw 업로드 → 자료 묶기. 바이트는 raw 본문으로 가서 10MB JSON
 * 상한에 걸리지 않는다.
 *
 * 실행:
 *   node scripts/publish-apk.mjs --server https://awb.example.com \
 *     --email admin@example.com --password '...' \
 *     --file apps/client/android/app/build/outputs/apk/debug/app-debug.apk \
 *     --version 1.0 --title "AWB Android"
 *
 * --account 로 계정을 지정할 수 있고(생략하면 첫 번째), 비밀번호 대신
 * --token 으로 세션 토큰을 직접 줄 수도 있다.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';

function arg(name, def = '') {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  if (eq >= 0) return hit.slice(eq + 1);
  const i = process.argv.indexOf(hit);
  return process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

async function fail(msg) {
  console.error(`publish-apk: ${msg}`);
  process.exit(1);
}

async function call(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    await fail(`HTTP ${res.status} ${method} ${url} — ${json?.message || json?.error || text.slice(0, 200)}`);
  }
  return json;
}

const server = (arg('server', 'http://localhost:7701') || '').replace(/\/+$/, '');
const email = arg('email');
const password = arg('password');
const tokenArg = arg('token');
const file = arg('file');
const version = arg('version', '');
const title = arg('title', 'AWB Android');
const description = arg('description', '');
let accountId = arg('account');

if (!file || !existsSync(file)) await fail(`--file 이 없습니다: ${file || '(미지정)'}`);
if (!tokenArg && (!email || !password)) await fail('--email/--password 또는 --token 이 필요합니다');
const size = statSync(file).size;
if (!/\.apk$/i.test(file)) console.error('publish-apk: 경고 — .apk가 아닙니다. 그래도 올립니다.');

let token = tokenArg;
if (!token) {
  const login = await call(`${server}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  token = login?.token;
  if (!token) await fail('로그인 응답에 token이 없습니다');
}
const auth = { Authorization: `Bearer ${token}` };

if (!accountId) {
  const accounts = await call(`${server}/api/accounts`, { headers: auth });
  const list = Array.isArray(accounts) ? accounts : accounts?.accounts || [];
  if (!list.length) await fail('접근 가능한 계정이 없습니다');
  accountId = list[0].id;
  console.error(`publish-apk: 계정 미지정 — '${list[0].name || accountId}' 사용`);
}

const bytes = readFileSync(file);
const { name: base } = { name: file.split(/[\\/]/).pop() };
const uploaded = await call(
  `${server}/api/resources/upload?${new URLSearchParams({ account_id: accountId, type: 'library_file' })}`,
  {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/vnd.android.package-archive', 'X-File-Name': encodeURIComponent(base) },
    body: bytes,
  },
);

const item = await call(`${server}/api/library`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ account_id: accountId, resource_id: uploaded.id, title, description, version, kind: 'app' }),
});

console.log(`ok — '${item.title}' v${item.version || '?'} (${(size / 1024 / 1024).toFixed(1)} MB) → 자료실, 앱 다운로드가 이 버전을 냅니다`);
