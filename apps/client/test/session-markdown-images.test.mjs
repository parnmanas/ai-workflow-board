// 세션 답 속 마크다운 이미지(`![alt](target)`) 분리 — Codex 데스크톱 앱처럼 에이전트가 로컬 경로로
// 적은 그림을 그리려면 먼저 "답의 어디가 그림인가" 를 정확히 떼어 내야 한다.
// 실행: node --import tsx --test apps/client/test/session-markdown-images.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMarkdownImages } from '../src/components/sessions/markdownImages.ts';

const images = (text) => splitMarkdownImages(text).filter((s) => s.kind === 'image');

test('Windows 드라이브 경로 이미지를 로컬로 떼어 내고 앞뒤 글은 그대로 둔다', () => {
  const text = '대장간 UI 를 바꿨습니다.\n![변경된 대장간 UI](E:/Repository/txiv/emberdelve/Docs/ui/town_forge_weapons.png)\n확인해 주세요.';
  assert.deepEqual(splitMarkdownImages(text), [
    { kind: 'text', text: '대장간 UI 를 바꿨습니다.' },
    { kind: 'image', alt: '변경된 대장간 UI', target: 'E:/Repository/txiv/emberdelve/Docs/ui/town_forge_weapons.png', source: 'local' },
    { kind: 'text', text: '확인해 주세요.' },
  ]);
});

test('에이전트가 실제로 쓰는 경로 모양을 모두 받는다 — 공백, <…>, 제목, 괄호, file://, posix', () => {
  const t = [
    '![a](E:\\shots\\my shot.png)',
    '![b](<C:/Program Files/x.png>)',
    '![c](/home/u/out.png "title")',
    '![d](./img/chart (1).png)',
    '![e](file:///E:/x.png)',
    '![f](/E:/x.png)',
  ].join('\n');
  assert.deepEqual(images(t).map((s) => [s.target, s.source]), [
    ['E:\\shots\\my shot.png', 'local'],
    ['C:/Program Files/x.png', 'local'],
    ['/home/u/out.png', 'local'],
    ['./img/chart (1).png', 'local'],
    ['file:///E:/x.png', 'local'],
    ['/E:/x.png', 'local'],
  ]);
});

test('http(s) 는 원격, 그 밖의 스킴(data:, javascript:)은 그림으로 다루지 않는다', () => {
  assert.deepEqual(images('![r](https://example.com/a.png)').map((s) => s.source), ['remote']);
  assert.deepEqual(images('![x](javascript:alert(1))'), []);
  assert.deepEqual(images('![x](data:image/png;base64,AAAA)'), []);
});

test('코드 안의 이미지 문법은 예시다 — 그리지 않는다', () => {
  const text = '인라인 `![a](E:/a.png)` 와\n```md\n![b](E:/b.png)\n```\n밖의 ![c](E:/c.png)';
  assert.deepEqual(images(text).map((s) => s.target), ['E:/c.png']);
});

test('닫히지 않은(스트리밍 중인) 이미지는 아직 글이다', () => {
  assert.deepEqual(images('보세요 ![a](E:/Repo/sho'), []);
  assert.deepEqual(splitMarkdownImages('보세요 ![a](E:/Repo/sho'), [{ kind: 'text', text: '보세요 ![a](E:/Repo/sho' }]);
});

test('이미지가 없으면 글 하나, 빈 글이면 아무것도 없다', () => {
  assert.deepEqual(splitMarkdownImages('그냥 글 [링크](x)'), [{ kind: 'text', text: '그냥 글 [링크](x)' }]);
  assert.deepEqual(splitMarkdownImages(''), []);
});
