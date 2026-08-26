import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('보드 child 행은 상태·담당자·진행률을 표시하고 별도 클릭을 전달한다', async () => {
  const card = await readFile(new URL('../src/components/TicketCard.tsx', import.meta.url), 'utf8');
  const column = await readFile(new URL('../src/components/Column.tsx', import.meta.url), 'utf8');
  assert.match(card, /child\.status/);
  assert.match(card, /child\.assignee \|\| '미할당'/);
  assert.match(card, /childDone}\/\{childTotal/);
  assert.match(card, /event\.stopPropagation\(\); onChildClick\?\.\(child\)/);
  assert.match(card, /background: `\$\{tokens\.colors\.accent\}12`/);
  assert.match(column, /onChildClick=\{onTicketClick\}/);
});

test('child는 Draggable로 등록되지 않아 root 이동 규칙을 사용하지 않는다', async () => {
  const card = await readFile(new URL('../src/components/TicketCard.tsx', import.meta.url), 'utf8');
  assert.equal((card.match(/<Draggable/g) || []).length, 1);
  assert.doesNotMatch(card, /draggableId=\{`ticket-\$\{child\.id\}`\}/);
});
