// 세션 헤더는 제목·폴더 길이나 화면 폭과 상관없이 같은 모양이어야 한다.
// 늘 보이는 설정은 승인 mode · 모델 · effort 셋뿐이고(이 순서), 나머지 설정·정보·동작은
// 햄버거 메뉴로 접는다. 접는 기준은 화면이 아니라 헤더 자신의 폭(container query)이다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { headerControlLabel, splitHeaderConfigOptions } from '../src/components/sessions/sessionTranscript.logic.ts';

const select = (config_id, category, name = config_id) => ({ config_id, category, name, type: 'select', current_value: null, options: [] });
const toggle = (config_id, category, name = config_id) => ({ config_id, category, name, type: 'boolean', current_value: false, options: [] });

test('header keeps mode · model · effort in that order; everything else goes to the menu', () => {
  // codex 가 실제로 보고하는 목록
  const codex = [select('mode', 'mode', 'Mode'), select('collaboration_mode', 'collaboration_mode'), select('model', 'model'),
    select('reasoning_effort', 'thought_level', 'Reasoning effort'), toggle('fast-mode', 'model_config', 'Fast mode')];
  const { primary, secondary } = splitHeaderConfigOptions(codex);
  assert.deepEqual(primary.map((o) => o.config_id), ['mode', 'model', 'reasoning_effort']);
  assert.deepEqual(secondary.map((o) => o.config_id), ['collaboration_mode', 'fast-mode']);

  // opencode 는 순서가 다르게 온다 — 헤더 순서는 어댑터가 아니라 화면이 정한다.
  const opencode = [select('model', 'model'), select('effort', 'thought_level'), select('mode', 'mode', 'Session Mode')];
  assert.deepEqual(splitHeaderConfigOptions(opencode).primary.map((o) => o.config_id), ['mode', 'model', 'effort']);
  assert.deepEqual(splitHeaderConfigOptions(opencode).secondary, []);

  // boolean 은 category 가 맞아도 헤더에 올리지 않는다.
  assert.deepEqual(splitHeaderConfigOptions([toggle('weird', 'model')]).primary, []);
});

test('header labels are fixed per category, not the adapter\'s long names', () => {
  assert.equal(headerControlLabel({ category: 'mode', name: 'Session Mode' }), 'Mode');
  assert.equal(headerControlLabel({ category: 'model', name: 'Model' }), 'Model');
  assert.equal(headerControlLabel({ category: 'thought_level', name: 'Reasoning effort' }), 'Effort');
  assert.equal(headerControlLabel({ category: 'collaboration_mode', name: 'Collaboration mode' }), 'Collaboration mode');
});

test('header layout folds by its own width and gives controls fixed widths', async () => {
  const css = await readFile(new URL('../src/responsive.css', import.meta.url), 'utf8');
  assert.match(css, /\.awb-session-header \{ container-type: inline-size; \}/);
  assert.match(css, /grid-template-areas: "identity controls actions"/);
  assert.match(css, /@container \(max-width: 900px\) \{[^}]*grid-template-areas: "identity actions" "controls controls"/);
  for (const category of ['mode', 'model', 'thought_level']) {
    assert.match(css, new RegExp(`\\.awb-session-control\\[data-category="${category}"\\] \\{ width: \\d+px; \\}`));
  }
  // 예전의 viewport 기반 Settings 토글과 숨김 클래스는 없어졌다.
  const page = await readFile(new URL('../src/components/sessions/SessionsPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /awb-session-extra|awb-session-settings|useMediaQuery/);
  assert.match(page, /<SessionHeaderMenu>/);
});
