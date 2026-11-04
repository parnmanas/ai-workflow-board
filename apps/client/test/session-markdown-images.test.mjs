// 세션 답 속 마크다운 이미지(`![alt](target)`) 분리 — Codex 데스크톱 앱처럼 에이전트가 로컬 경로로
// 적은 그림을 그리려면 먼저 "답의 어디가 그림인가" 를 정확히 떼어 내야 한다.
// 실행: node --import tsx --test apps/client/test/session-markdown-images.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRemoteVideoUrl, splitMarkdownImages } from '../src/components/sessions/markdownImages.ts';
import { setupDom, mount, click, React, act } from './helpers/jsdom.mjs';
import { ui, uiPattern } from './helpers/i18n.mjs';
import { api } from '../src/api.ts';
import SessionTranscript from '../src/components/sessions/SessionTranscript.tsx';
import { buildTranscript } from '../src/components/sessions/sessionTranscript.logic.ts';

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

test('로컬 html/md 는 이미지와 같은 자리에서 파일 미리보기로 떼어 낸다 — `!` 유무와 무관', () => {
  const text = '보고서 나왔습니다.\n![결과](./report.html)\n[상세](./notes.md)\n확인해 주세요.';
  assert.deepEqual(splitMarkdownImages(text), [
    { kind: 'text', text: '보고서 나왔습니다.' },
    { kind: 'file', alt: '결과', target: './report.html', source: 'local', fileKind: 'html' },
    { kind: 'file', alt: '상세', target: './notes.md', source: 'local', fileKind: 'markdown' },
    { kind: 'text', text: '확인해 주세요.' },
  ]);
});

test('html/md 판정은 확장자로만 — 대소문자·쿼리·절대경로도 받는다', () => {
  const t = [
    '![a](E:\\out\\Report.HTML)',
    '![b](/home/u/notes.Markdown?rev=2)',
    '[c](<C:/Program Files/r e p o r t.htm>)',
  ].join('\n');
  assert.deepEqual(splitMarkdownImages(t).map((s) => [s.target, s.fileKind]), [
    ['E:\\out\\Report.HTML', 'html'],
    ['/home/u/notes.Markdown?rev=2', 'markdown'],
    ['C:/Program Files/r e p o r t.htm', 'html'],
  ]);
});

test('html/md 가 아닌 일반 링크는 건드리지 않고 한 텍스트로 남긴다', () => {
  assert.deepEqual(splitMarkdownImages('그냥 글 [링크](./other.txt) 끝'), [
    { kind: 'text', text: '그냥 글 [링크](./other.txt) 끝' },
  ]);
  // 이미지 문법의 비-html/md 로컬 경로도 기존대로 이미지다(매니저가 사유와 함께 거절).
  assert.deepEqual(splitMarkdownImages('![a](E:/x.txt)'), [
    { kind: 'image', alt: 'a', target: 'E:/x.txt', source: 'local' },
  ]);
});

test('코드 안의 파일 문법은 예시다 — 그리지 않는다', () => {
  const text = '인라인 `[a](./r.html)` 와\n```md\n![b](./b.md)\n```\n밖의 ![c](./c.html)';
  assert.deepEqual(
    splitMarkdownImages(text).filter((s) => s.kind === 'file').map((s) => s.target),
    ['./c.html'],
  );
});

// ─── 영상 ───────────────────────────────────────────────────────────
//
// 실제 쓰임: 다이빙 영상을 편집하는 세션의 에이전트가 렌더한 미리보기를 자기 장비의 사이트에 올리고
// `- [#1 다나오 비치 · 0:35](https://…/preview/bohol-dive-1.mp4)` 목록이나 `▶ https://…mp4` 로 알렸다.
// 화면에서는 링크라 새 탭으로만 볼 수 있었다.

const videos = (text) => splitMarkdownImages(text).filter((s) => s.kind === 'video');

test('영상: 로컬 경로는 `!` 유무와 무관하게, 원격은 이미지 문법일 때만 카드로 떼어 낸다', () => {
  const text = [
    '렌더했습니다.',
    '![데모](./out/demo.mp4)',
    '[녹화](E:\\rec\\play session.WEBM)',
    '![원격](https://cdn.example.com/a/clip.mov?sig=1)',
    '[링크로 둔 원격](https://dive.example.com/preview/bohol-pool.mp4)',
  ].join('\n');
  assert.deepEqual(splitMarkdownImages(text), [
    { kind: 'text', text: '렌더했습니다.' },
    { kind: 'video', alt: '데모', target: './out/demo.mp4', source: 'local' },
    { kind: 'video', alt: '녹화', target: 'E:\\rec\\play session.WEBM', source: 'local' },
    { kind: 'video', alt: '원격', target: 'https://cdn.example.com/a/clip.mov?sig=1', source: 'remote' },
    // 원격 링크는 글에 남는다 — 목록 속 링크를 카드로 떼면 목록이 끊긴다. 재생은 전사의 링크 렌더러가 맡는다.
    { kind: 'text', text: '[링크로 둔 원격](https://dive.example.com/preview/bohol-pool.mp4)' },
  ]);
});

test('영상: 코드 안의 문법은 예시다 — 떼지 않는다', () => {
  const text = '인라인 `![a](./a.mp4)` 와\n```md\n[b](./b.webm)\n```\n밖의 [c](./c.mkv)';
  assert.deepEqual(videos(text).map((s) => s.target), ['./c.mkv']);
});

test('isRemoteVideoUrl: http(s) 이고 경로 끝이 영상 확장자일 때만', () => {
  assert.equal(isRemoteVideoUrl('https://dive.example.com/preview/bohol-pool.mp4'), true);
  assert.equal(isRemoteVideoUrl('http://host/x/Clip.WEBM#t=10'), true);
  assert.equal(isRemoteVideoUrl('https://host/watch?file=a.mp4'), false, '쿼리 속 파일명은 영상 파일 주소가 아니다');
  assert.equal(isRemoteVideoUrl('https://host/a.mp4.html'), false);
  assert.equal(isRemoteVideoUrl('./out/demo.mp4'), false, '로컬 경로는 카드가 맡는다');
  assert.equal(isRemoteVideoUrl('javascript:alert(1)//.mp4'), false);
});

function transcriptOf(text, props = {}) {
  const blocks = buildTranscript([{ type: 'text', payload: { text }, id: '1', seq: 1, turn_id: 'turn', created_at: new Date().toISOString() }]);
  return mount(React.createElement(SessionTranscript, {
    blocks, decidingRequestId: null, permissionsEnabled: true, onDecidePermission() {}, ...props,
  }));
}

/** jsdom 은 재생을 구현하지 않는다 — 부른 것만 기록한다. */
function stubMedia(t) {
  t.mock.method(window.HTMLMediaElement.prototype, 'pause', () => {});
  return t.mock.method(window.HTMLMediaElement.prototype, 'play', () => Promise.resolve());
}

const POOL = 'https://dive.example.com/preview/bohol-pool.mp4';
const DIVE1 = 'https://dive.example.com/preview/bohol-dive-1.mp4';
const SAMPLE = 'https://dive.example.com/preview/bohol-dive-1-v1.mp4';

test('영상 링크: 목록은 그대로 두고 링크 바로 아래에 썸네일을 보이며, 링크를 누르면 새 탭 대신 그 자리에서 재생한다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());
  const play = stubMedia(t);
  const text = [
    '**보홀**',
    `- [제한수역(풀장) 교육 · 1:54](${POOL})`,
    `- [#1 다나오 비치 · 0:35](${DIVE1})`,
    '',
    `▶ ${SAMPLE}`,
    '',
    '[안내](https://dive.example.com/guide.html)',
  ].join('\n');
  const view = transcriptOf(text);
  t.after(() => view.unmount());
  await act(async () => {});
  const links = [...view.container.querySelectorAll('a[data-video-link]')];
  assert.deepEqual(links.map((a) => a.getAttribute('href')), [POOL, DIVE1, SAMPLE], '목록 속 링크와 맨 URL 이 모두 영상이다');
  assert.equal(view.container.querySelectorAll('ul').length, 1, '목록이 끊기지 않는다');
  const items = [...view.container.querySelectorAll('ul > li')];
  assert.equal(items.length, 2);
  // 썸네일은 그 링크의 목록 칸 안에 — 영상 전체가 아니라 한 장면(#t=1)과 메타데이터만 받는다.
  assert.deepEqual(
    items.map((li) => li.querySelector('[data-video-thumb] video')?.getAttribute('src')),
    [`${POOL}#t=1`, `${DIVE1}#t=1`],
  );
  assert.equal(items[0].querySelector('[data-video-thumb] video')?.getAttribute('preload'), 'metadata');
  assert.equal(items[0].querySelector('[data-video-thumb] video')?.hasAttribute('controls'), false, '누르기 전에는 썸네일');
  const guide = [...view.container.querySelectorAll('a')].find((a) => a.getAttribute('href') === 'https://dive.example.com/guide.html');
  assert.equal(guide?.hasAttribute('data-video-link'), false, '영상이 아닌 링크는 그대로다');

  // 문서 단계에서 기본 동작이 막혔는지 기록하고, jsdom 이 실제로 이동하지 않게 막는다.
  const prevented = [];
  const record = (e) => { prevented.push(e.defaultPrevented); e.preventDefault(); };
  document.addEventListener('click', record);
  t.after(() => document.removeEventListener('click', record));
  await act(async () => {
    links[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  });
  assert.deepEqual(prevented, [false], 'Ctrl+클릭은 브라우저의 새 탭 열기 그대로');
  assert.equal(play.mock.calls.length, 0);

  await act(async () => { click(links[1]); });
  assert.deepEqual(prevented, [false, true], '보통 클릭은 새 탭 대신 그 자리에서');
  const playingThumb = items[1].querySelector('[data-video-thumb]');
  assert.equal(playingThumb?.getAttribute('data-playing'), 'true');
  assert.equal(playingThumb?.querySelector('video')?.hasAttribute('controls'), true);
  assert.equal(play.mock.calls.length, 1, '바로 재생한다');
  assert.equal(document.querySelectorAll('[data-testid="media-lightbox"]').length, 0, '팝업이 아니라 전사 안에서 본다');
  assert.equal(items[0].querySelector('[data-video-thumb]')?.getAttribute('data-playing'), 'false', '다른 영상은 썸네일 그대로');

  // ⤢ 는 크게 보기 — 갤러리에서 ← → 로 다른 영상으로 넘긴다.
  const expand = playingThumb?.querySelector(`button[aria-label="${ui('Expand video')}"]`);
  await act(async () => { click(expand); });
  const lightbox = document.querySelector('[data-testid="media-lightbox"]');
  assert.ok(lightbox, '크게 보기 갤러리');
  assert.equal(lightbox.querySelector('video')?.getAttribute('src'), DIVE1);
  assert.equal(lightbox.querySelector('[data-testid="media-lightbox-counter"]')?.textContent, '2 / 3');
  const open = [...lightbox.querySelectorAll('a')].find((a) => a.textContent === ui('새 탭에서 열기'));
  assert.equal(open?.getAttribute('target'), '_blank', '다른 출처는 download 가 무시되고 이 탭이 넘어가 버린다');
});

test('로컬 영상: 보이면 앞부분만 받아 썸네일을 그리고, 누르면 끝까지 받아 그 자리에서 재생한다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());
  const play = stubMedia(t);
  const previews = [];
  const fulls = [];
  let finish;
  const loadLocalVideoPreview = async (path) => {
    previews.push(path);
    return { blob: new Blob([new Uint8Array(1024)], { type: 'video/mp4' }), size: 3 * 1024 * 1024 };
  };
  const loadLocalVideo = (path, options) => {
    fulls.push(path);
    options.onProgress(1024 * 1024, 3 * 1024 * 1024);
    return new Promise((resolve) => { finish = resolve; });
  };
  let made = 0;
  t.mock.method(URL, 'createObjectURL', () => `blob:video-${++made}`);
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});
  const view = transcriptOf('데모입니다.\n![데모](./out/demo.mp4)', { loadLocalVideo, loadLocalVideoPreview });
  let unmounted = false;
  t.after(() => { if (!unmounted) view.unmount(); });
  await act(async () => {});
  assert.deepEqual(previews, ['./out/demo.mp4'], '썸네일용 앞부분만 받는다');
  assert.deepEqual(fulls, [], '영상 전체는 누를 때 받는다');
  assert.equal(view.container.querySelector('[data-video-thumb] video')?.getAttribute('src'), 'blob:video-1#t=1');
  assert.match(view.container.querySelector('[data-video-badge]')?.textContent ?? '', /3\.0MB/);
  await act(async () => { click(view.container.querySelector(`button[aria-label="${ui('영상 재생')}"]`)); });
  assert.deepEqual(fulls, ['./out/demo.mp4']);
  assert.match(view.container.textContent, uiPattern('영상 불러오는 중… {0}', { 0: '1.0 / 3.0MB' }));
  await act(async () => { finish(new Blob(['video bytes'], { type: 'video/mp4' })); });
  assert.equal(view.container.querySelector('[data-video-thumb] video')?.getAttribute('src'), 'blob:video-2');
  assert.equal(view.container.querySelector('[data-video-thumb] video')?.hasAttribute('controls'), true);
  assert.equal(play.mock.calls.length, 1, '다 받으면 그 자리에서 재생한다');
  const download = [...view.container.querySelectorAll('a')].find((a) => a.textContent === ui('다운로드'));
  assert.equal(download?.getAttribute('download'), 'demo.mp4');
  view.unmount();
  unmounted = true;
  assert.equal(revoke.mock.calls.length, 2, '썸네일·영상 URL 은 전사를 떠날 때 풀린다');
});

test('로컬 영상: 앞부분이 곧 전부인 작은 파일은 다시 받지 않고 그대로 재생한다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());
  const play = stubMedia(t);
  const fulls = [];
  t.mock.method(URL, 'createObjectURL', () => 'blob:small');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const view = transcriptOf('![녹화](./rec.webm)', {
    loadLocalVideoPreview: async () => ({ blob: new Blob([new Uint8Array(1000)], { type: 'video/webm' }), size: 1000 }),
    loadLocalVideo: async (path) => { fulls.push(path); return new Blob([]); },
  });
  t.after(() => view.unmount());
  await act(async () => {});
  await act(async () => { click(view.container.querySelector(`button[aria-label="${ui('영상 재생')}"]`)); });
  assert.deepEqual(fulls, [], '이미 다 받았다');
  assert.equal(view.container.querySelector('[data-video-thumb] video')?.getAttribute('src'), 'blob:small');
  assert.equal(play.mock.calls.length, 1);
});

test('로컬 영상: 못 받으면 사유와 다시 시도를 그 자리에 보이고, 받는 중에 떠나면 멈춘다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());
  stubMedia(t);
  t.mock.method(URL, 'createObjectURL', () => 'blob:preview');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  let previewCalls = 0;
  const loadLocalVideoPreview = async () => {
    previewCalls++;
    if (previewCalls === 1) throw new Error('Update the agent manager on this Runtime Host to play local videos.');
    return { blob: new Blob([new Uint8Array(10)], { type: 'video/webm' }), size: 100 };
  };
  const signals = [];
  const loadLocalVideo = (_path, options) => { signals.push(options.signal); return new Promise(() => {}); };
  const view = transcriptOf('[녹화](E:/rec/play.webm)', { loadLocalVideo, loadLocalVideoPreview });
  let unmounted = false;
  t.after(() => { if (!unmounted) view.unmount(); });
  await act(async () => {});
  assert.match(view.container.textContent, uiPattern('영상을 가져오지 못했습니다 —'));
  assert.match(view.container.textContent, /Update the agent manager/);
  assert.match(view.container.textContent, /E:\/rec\/play\.webm/, '경로가 그 자리에 남는다');
  const retry = [...view.container.querySelectorAll('button')].find((b) => b.textContent === ui('다시 시도'));
  await act(async () => { click(retry); });
  await act(async () => {});
  assert.equal(previewCalls, 2);
  assert.equal(view.container.querySelector('[data-video-thumb] video')?.getAttribute('src'), 'blob:preview#t=1');
  await act(async () => { click(view.container.querySelector(`button[aria-label="${ui('영상 재생')}"]`)); });
  assert.equal(signals.length, 1);
  view.unmount();
  unmounted = true;
  assert.equal(signals[0].aborted, true, '받는 중에 전사를 떠나면 남은 조각을 받지 않는다');
});

test('getHostSessionLocalVideo: 조각을 Range 로 이어 받아 한 Blob 으로 만들고, 파일이 바뀌면 섞지 않고 멈춘다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = dom.window.localStorage;
  t.after(() => { if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage; });
  const bytes = Buffer.from('0123456789');
  const ranges = [];
  let etag = () => '"10-1"';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    ranges.push(init.headers.Range);
    const start = Number(/^bytes=(\d+)-$/.exec(init.headers.Range)[1]);
    const end = Math.min(start + 3, bytes.length - 1);
    return new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Type': 'video/webm', ETag: etag(start) },
    });
  });
  const progress = [];
  const blob = await api.getHostSessionLocalVideo('host', 'codex', 'sess', './out/demo.webm', '/repo', {
    onProgress: (loaded, total) => progress.push([loaded, total]),
  });
  assert.deepEqual(ranges, ['bytes=0-', 'bytes=4-', 'bytes=8-']);
  assert.equal(blob.type, 'video/webm');
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), '0123456789');
  assert.deepEqual(progress, [[4, 10], [8, 10], [10, 10]]);
  assert.match(String(globalThis.fetch.mock.calls[0].arguments[0]), /\/agent-sessions\/hosts\/host\/codex\/sessions\/sess\/local-video\?path=\.%2Fout%2Fdemo\.webm&cwd=%2Frepo$/);

  etag = (start) => (start === 0 ? '"10-1"' : '"10-2"');
  await assert.rejects(
    api.getHostSessionLocalVideo('host', 'codex', 'sess', './out/demo.webm', '/repo'),
    { message: ui('영상 파일이 불러오는 동안 바뀌었습니다. 다시 시도해 주세요.') },
  );
});

test('getHostSessionLocalVideoPreview: 앞부분을 한 번만 Range 로 받고 파일 전체 크기를 함께 돌려준다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = dom.window.localStorage;
  t.after(() => { if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage; });
  const ranges = [];
  let contentRange = 'bytes 0-9/50';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    ranges.push(init.headers.Range);
    return new Response(Buffer.from('0123456789'), { status: 206, headers: { 'Content-Range': contentRange, 'Content-Type': 'video/mp4' } });
  });
  const head = await api.getHostSessionLocalVideoPreview('host', 'codex', 'sess', './out/demo.mp4', '/repo');
  assert.deepEqual(ranges, ['bytes=0-4194303'], '썸네일용 앞부분 4MiB 한 번');
  assert.deepEqual([head.size, head.blob.size], [50, 10]);
  contentRange = 'bytes 0-99/50';
  await assert.rejects(api.getHostSessionLocalVideoPreview('host', 'codex', 'sess', './out/demo.mp4', '/repo'), { message: ui('영상 응답을 해석하지 못했습니다.') });
});
