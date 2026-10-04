// Operators 레지스트리 — docs/voice-operator.md "Operator".
//
// 고정하는 것:
//   1. 한 개만 두던 시절의 `operator.session` 은 처음 읽을 때 목록으로 옮겨지고(이름 "Operator"), 옛 행은
//      지워진다. 옮긴 항목의 id 는 세션 주소에서 정해져 두 번 옮겨도 같다.
//   2. 이름 비교는 대소문자·공백·문장부호를 무시한다 — 부르는 말이 같으면 같은 이름이다.
//   3. 이름·별칭은 operator 끼리 겹칠 수 없고, 별칭은 정리된다(이름과 같은 것·중복·빈 것 제거, 상한).
//   4. 겹친 등록이 서로를 덮어쓰지 않는다(updateOperators 가 읽고-고치고-쓰기를 한 줄로 세운다).
//
// 실행: node --test test/voice-operators.test.mjs (dist 필요)

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEGACY_OPERATOR_SETTING_KEY,
  MAX_OPERATOR_ALIASES,
  OPERATORS_SETTING_KEY,
  OperatorInputError,
  createOperatorEntry,
  operatorNameKey,
  patchOperatorEntry,
  readOperators,
  updateOperators,
} from '../dist/modules/voice/operator-config.js';

/** SystemSetting 저장소 흉내 — 쓰기마다 한 틱 늦게 끝나 겹친 쓰기를 드러낸다. */
function fakeDataSource(initial = {}) {
  const rows = new Map(Object.entries(initial).map(([key, value]) => [key, { key, value }]));
  const repo = {
    findOne: async ({ where: { key } }) => (rows.has(key) ? { ...rows.get(key) } : null),
    create: (value) => ({ ...value }),
    save: async (row) => {
      await new Promise((r) => setTimeout(r, 2));
      rows.set(row.key, { ...row });
      return row;
    },
    remove: async (row) => {
      rows.delete(row.key);
      return row;
    },
  };
  return { rows, getRepository: () => repo };
}

const session = (n) => ({ manager_id: `host-${n}`, cli: 'claude', session_id: `s${n}` });

test('the single legacy operator moves into the list once, with a stable id', async () => {
  const legacy = { ...session(1), cwd: '/home/parn/op', title: 'Ops', pinned_at: '2026-10-01T00:00:00.000Z', pinned_by: 'u1' };
  const ds = fakeDataSource({ [LEGACY_OPERATOR_SETTING_KEY]: JSON.stringify(legacy) });
  const [moved] = await readOperators(ds);
  assert.equal(moved.name, 'Operator');
  assert.deepEqual(moved.aliases, ['오퍼레이터']);
  assert.deepEqual([moved.manager_id, moved.cli, moved.session_id, moved.cwd, moved.created_by], ['host-1', 'claude', 's1', '/home/parn/op', 'u1']);
  assert.equal(ds.rows.has(LEGACY_OPERATOR_SETTING_KEY), false, 'the old row is gone — one place to look');
  assert.deepEqual((await readOperators(ds)).map((op) => op.id), [moved.id], 'reading again changes nothing');

  const again = fakeDataSource({ [LEGACY_OPERATOR_SETTING_KEY]: JSON.stringify(legacy) });
  assert.equal((await readOperators(again))[0].id, moved.id, 'the same session always migrates to the same id');

  const cleared = fakeDataSource({ [LEGACY_OPERATOR_SETTING_KEY]: '' });
  assert.deepEqual(await readOperators(cleared), []);
  assert.equal(cleared.rows.get(OPERATORS_SETTING_KEY)?.value, '[]');
  assert.equal(cleared.rows.has(LEGACY_OPERATOR_SETTING_KEY), false);
});

test('a name is what you say: case, spaces and punctuation do not make a different one', () => {
  assert.equal(operatorNameKey('Jarvis'), operatorNameKey(' JAR-VIS! '));
  assert.equal(operatorNameKey('자비스'), operatorNameKey('자 비 스'));
  assert.notEqual(operatorNameKey('자비스'), operatorNameKey('쟈비스'));
});

test('names and aliases call exactly one operator; aliases are tidied', () => {
  const jarvis = createOperatorEntry({ name: 'Jarvis', aliases: ['자비스', ' jarvis ', '', '자비스', ...Array.from({ length: 12 }, (_, i) => `a${i}`)], ...session(1) }, 'u1', []);
  assert.equal(jarvis.aliases[0], '자비스');
  assert.ok(!jarvis.aliases.some((a) => operatorNameKey(a) === 'jarvis'), 'an alias equal to the name is dropped');
  assert.equal(jarvis.aliases.length, MAX_OPERATOR_ALIASES);

  const clash = (fn) => assert.throws(fn, (err) => err instanceof OperatorInputError && err.code === 'operator_name_taken');
  clash(() => createOperatorEntry({ name: 'jar vis', ...session(2) }, 'u1', [jarvis]));
  clash(() => createOperatorEntry({ name: 'Friday', aliases: '자비스', ...session(2) }, 'u1', [jarvis]));
  const friday = createOperatorEntry({ name: 'Friday', ...session(2) }, 'u1', [jarvis]);
  clash(() => patchOperatorEntry(friday, { name: 'JARVIS' }, [jarvis, friday]));
  const renamed = patchOperatorEntry(jarvis, { name: 'Jarvis', aliases: '자비스' }, [jarvis, friday]);
  assert.deepEqual(renamed.aliases, ['자비스'], 'an operator may keep its own names');
  assert.equal(renamed.session_id, 's1', 'renaming never moves the operator to another session');
});

test('overlapping registrations do not overwrite each other', async () => {
  const ds = fakeDataSource({ [OPERATORS_SETTING_KEY]: '[]' });
  const add = (name, n) => updateOperators(ds, (list) => {
    const operator = createOperatorEntry({ name, ...session(n) }, 'u1', list);
    return { next: [...list, operator], result: operator };
  });
  await Promise.all([add('Jarvis', 1), add('Friday', 2), add('Karen', 3)]);
  assert.deepEqual((await readOperators(ds)).map((op) => op.name).sort(), ['Friday', 'Jarvis', 'Karen']);
  await assert.rejects(add('JARVIS', 4), (err) => err.code === 'operator_name_taken');
  assert.equal((await readOperators(ds)).length, 3, 'a rejected change writes nothing');
});
