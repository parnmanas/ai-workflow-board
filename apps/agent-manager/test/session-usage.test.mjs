// 세션 전사의 토큰 사용량 — CLI 별 매핑과 공용 계약 (운영 보고 2026-09-26:
// "대화에서 사용하는 토큰이 제대로 나오지 않아. 어떤 cli 는 잘 나오고 어떤건 제대로
// 안나와. 특히 claude 는 제대로 안나와").
//
// 고치기 전:
//   · 기록(history)에는 어떤 CLI 도 usage 이벤트를 만들지 않았다 — claude 의 JSONL 과
//     codex 의 rollout 에 사용량이 적혀 있는데도 파서가 그 레코드를 그냥 버렸고,
//     opencode 의 step-finish 는 "보일 것이 없다"로 분류돼 있었다.
//   · 라이브 턴은 ACP 어댑터가 자발적으로 usage 를 줄 때만 나왔다. claude-agent-acp 는
//     주지 않으므로 claude 는 영영 안 나왔다.
//   · CLI 마다 `input_tokens` 의 뜻이 다르다(claude=캐시 제외, codex=캐시 포함)라
//     정규화 없이는 같은 숫자가 다른 뜻이 된다.
//
// 여기서 고정하는 계약:
//   ① 공용 계약의 `input_tokens` 는 **캐시 제외** 신규 입력, total 은 조각의 합.
//   ② claude 기록 → 턴 단위 usage 이벤트(캐시 읽기/쓰기 포함).
//   ③ codex 기록 → token_count 의 last_token_usage, 캐시는 input 에서 빼서 싣는다.
//   ④ 아무 토큰도 없으면 usage 를 만들지 않는다(0 은 계측 실패와 구분되지 않는다).
//   ⑤ 라이브 메꿈: 어댑터가 안 주면 CLI 기록의 마지막 usage 를 읽어 낸다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSessionStore } from '../dist/lib/agent-session-store.js';
import { normalizeSessionUsage, addSessionUsage, usageEventPayload } from '../dist/lib/session-usage.js';
import { claudeUsageFromMessage } from '../dist/lib/clis/claude/sessions.js';
import { codexUsageFromInfo } from '../dist/lib/clis/codex/sessions.js';
import { opencodeUsageFromPart } from '../dist/lib/clis/opencode/sessions.js';

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';
const CODEX_ID = '019d5d74-427c-7d13-b1c4-a54e0081374a';
const ts = (s) => `2026-09-26T00:00:${String(s).padStart(2, '0')}.000Z`;

// 실측 모양(이 저장소의 ~/.claude/projects, ~/.codex/sessions 에서 그대로 옮김).
const CLAUDE_USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 24187,
  cache_read_input_tokens: 11590,
  output_tokens: 346,
  output_tokens_details: { thinking_tokens: 120 },
};
const CODEX_INFO = {
  total_token_usage: { input_tokens: 15358, cached_input_tokens: 12160, cache_write_input_tokens: 0, output_tokens: 207, reasoning_output_tokens: 0, total_tokens: 15565 },
  last_token_usage: { input_tokens: 15358, cached_input_tokens: 12160, cache_write_input_tokens: 0, output_tokens: 207, reasoning_output_tokens: 0, total_tokens: 15565 },
  model_context_window: 258400,
};

test('① 공용 계약: input 은 캐시 제외, total 은 조각의 합, 빈 사용량은 null', () => {
  const usage = normalizeSessionUsage({ inputTokens: 10, outputTokens: 5, cachedReadTokens: 100, cacheWriteTokens: 50 });
  assert.equal(usage.total_tokens, 165, 'total = input + output + cache read + cache write');
  assert.equal(normalizeSessionUsage({}), null, '토큰이 없으면 usage 를 만들지 않는다');
  assert.equal(normalizeSessionUsage({ inputTokens: 0, outputTokens: 0 }), null, '0 만 담긴 usage 도 만들지 않는다');
  // reasoning 은 output 의 내역이라 total 에 더하지 않는다.
  const withReasoning = normalizeSessionUsage({ outputTokens: 100, reasoningTokens: 40 });
  assert.equal(withReasoning.total_tokens, 100);
  assert.equal(withReasoning.reasoning_tokens, 40);
  // 여러 API 호출 합산: 컨텍스트 값은 누적이 아니라 마지막 것.
  const merged = addSessionUsage(
    normalizeSessionUsage({ inputTokens: 1, outputTokens: 2, contextTokens: 500 }),
    normalizeSessionUsage({ inputTokens: 3, outputTokens: 4, contextTokens: 900 }),
  );
  assert.equal(merged.input_tokens, 4);
  assert.equal(merged.output_tokens, 6);
  assert.equal(merged.context_tokens, 900);
});

test('② claude 매핑: 캐시가 함께 실려야 합이 맞는다 (in=2 만 보여 주던 증상)', () => {
  const usage = claudeUsageFromMessage({ usage: CLAUDE_USAGE });
  assert.equal(usage.input_tokens, 2);
  assert.equal(usage.cached_read_tokens, 11590);
  assert.equal(usage.cache_write_tokens, 24187);
  assert.equal(usage.output_tokens, 346);
  assert.equal(usage.reasoning_tokens, 120);
  assert.equal(usage.total_tokens, 2 + 346 + 11590 + 24187, '실제로 쓴 토큰은 3.6만 대다 — 2 가 아니다');
  assert.equal(claudeUsageFromMessage({}), null);
  assert.equal(claudeUsageFromMessage(null), null);
});

test('③ codex 매핑: 캐시를 input 에서 빼 claude 와 같은 뜻으로 만든다', () => {
  const usage = codexUsageFromInfo(CODEX_INFO);
  assert.equal(usage.input_tokens, 15358 - 12160, 'codex 의 input 은 캐시를 포함하므로 빼야 이중 계산이 아니다');
  assert.equal(usage.cached_read_tokens, 12160);
  assert.equal(usage.output_tokens, 207);
  assert.equal(usage.total_tokens, 15565, 'CLI 가 주는 total 이 있으면 그것을 쓴다');
  assert.equal(usage.context_window, 258400);
  assert.equal(usage.context_tokens, 15565, '세션 누적이 현재 컨텍스트 점유에 가장 가깝다');
  assert.equal(codexUsageFromInfo(null), null);
});

test('③-b opencode 매핑: step-finish 의 tokens/cost 를 읽는다', () => {
  const usage = opencodeUsageFromPart({ tokens: { input: 1200, output: 300, reasoning: 80, cache: { read: 9000, write: 400 } }, cost: 0.0123 });
  assert.equal(usage.input_tokens, 1200);
  assert.equal(usage.cached_read_tokens, 9000);
  assert.equal(usage.cache_write_tokens, 400);
  assert.equal(usage.total_tokens, 1200 + 300 + 9000 + 400);
  assert.equal(usage.cost_usd, 0.0123);
  assert.equal(opencodeUsageFromPart({}), null);
});

test('④ payload 는 화면이 읽는 키를 모두 싣는다', () => {
  const payload = usageEventPayload(claudeUsageFromMessage({ usage: CLAUDE_USAGE }));
  assert.equal(payload.input_tokens, 2);
  assert.equal(payload.cached_read_tokens, 11590);
  assert.equal(payload.cache_write_tokens, 24187);
  assert.equal(payload.total_tokens, 36125);
  assert.equal(payload.reasoning_tokens, 120);
});

async function seedHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'awb-session-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeHome = join(root, 'claude');
  const codexHome = join(root, 'codex');
  const projectDir = join(claudeHome, 'projects', '-tmp-work-repo');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, `${CLAUDE_ID}.jsonl`), jsonl([
    { type: 'user', uuid: 'u1', sessionId: CLAUDE_ID, cwd: '/tmp/work/repo', timestamp: ts(1), message: { role: 'user', content: '첫 질문' } },
    // 한 턴에 API 호출이 두 번(툴 왕복) — 합쳐 한 줄로 나와야 한다.
    { type: 'assistant', uuid: 'a1', sessionId: CLAUDE_ID, timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'text', text: '보는 중' }], usage: CLAUDE_USAGE } },
    { type: 'assistant', uuid: 'a2', sessionId: CLAUDE_ID, timestamp: ts(3), message: { role: 'assistant', content: [{ type: 'text', text: '끝' }], usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 50 } } },
    { type: 'user', uuid: 'u2', sessionId: CLAUDE_ID, timestamp: ts(4), message: { role: 'user', content: '두 번째 질문' } },
    { type: 'assistant', uuid: 'a3', sessionId: CLAUDE_ID, timestamp: ts(5), message: { role: 'assistant', content: [{ type: 'text', text: '답' }], usage: { input_tokens: 7, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 11 } } },
  ]));
  const codexDir = join(codexHome, 'sessions', '2026', '09', '26');
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, `rollout-2026-09-26T10-00-00-${CODEX_ID}.jsonl`), jsonl([
    { timestamp: ts(0), type: 'session_meta', payload: { id: CODEX_ID, timestamp: ts(0), cwd: '/tmp/work/codex' } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '리뷰해줘' }] } },
    { timestamp: ts(2), type: 'event_msg', payload: { type: 'token_count', info: CODEX_INFO } },
    { timestamp: ts(3), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '두 가지 위험' }] } },
    { timestamp: ts(4), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
  ]));
  return { root, claudeHome, codexHome, indexPath: join(root, 'index.json') };
}

test('⑤ claude 기록: 턴마다 한 줄의 usage 가 나오고, 여러 API 호출은 합쳐진다', async (t) => {
  const home = await seedHome(t);
  const store = new AgentSessionStore(home);
  const history = await store.readHistory('claude', CLAUDE_ID);
  const usages = history.events.filter((e) => e.type === 'usage');
  assert.equal(usages.length, 2, '턴이 두 개면 usage 도 두 줄 — API 호출마다 뿌리지 않는다');
  assert.equal(usages[0].payload.total_tokens, 36125 + 153, '첫 턴의 두 호출이 합산된다');
  assert.equal(usages[1].payload.total_tokens, 7 + 11 + 200);
  // 순서: 첫 턴 usage 는 두 번째 프롬프트보다 앞이다.
  const kinds = history.events.map((e) => e.type);
  assert.ok(kinds.indexOf('usage') < kinds.lastIndexOf('user_prompt'), '턴 경계에서 방출한다');
});

test('⑤-b codex 기록: token_count 가 턴 종료와 함께 한 줄로 나온다', async (t) => {
  const home = await seedHome(t);
  const store = new AgentSessionStore(home);
  const history = await store.readHistory('codex', CODEX_ID);
  const usages = history.events.filter((e) => e.type === 'usage');
  assert.equal(usages.length, 1);
  assert.equal(usages[0].payload.input_tokens, 3198);
  assert.equal(usages[0].payload.cached_read_tokens, 12160);
  assert.equal(usages[0].payload.context_window, 258400);
  const kinds = history.events.map((e) => e.type);
  assert.ok(kinds.indexOf('usage') < kinds.indexOf('turn'), 'usage 가 턴 종료 줄보다 앞이다');
});

test('⑤-c 라이브 메꿈: 어댑터가 usage 를 안 줘도 기록에서 마지막 값을 읽는다', async (t) => {
  const home = await seedHome(t);
  const store = new AgentSessionStore(home);
  const claudeUsage = await store.readLatestUsage('claude', CLAUDE_ID);
  assert.equal(claudeUsage.total_tokens, 7 + 11 + 200, '파일 꼬리의 마지막 assistant 사용량');
  const codexUsage = await store.readLatestUsage('codex', CODEX_ID);
  assert.equal(codexUsage.total_tokens, 15565);
  // 기록 저장소가 없는 CLI(hermes)는 조용히 null — 라이브 경로가 예외로 죽지 않는다.
  assert.equal(await store.readLatestUsage('hermes', CLAUDE_ID), null);
  assert.equal(await store.readLatestUsage('claude', 'not-a-session-id'), null);
});
