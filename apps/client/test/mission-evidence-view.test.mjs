// 미션 검증 증거(스크린샷·동영상) 표시 회귀 테스트 (운영 요청 2026-09-25).
//
// 계약:
//   1. Evidence 탭은 미디어를 step 별로 묶어 썸네일로 보여주고, 미션 방 항목이 맨 앞이다.
//   2. 썸네일을 누르면 라이트박스 — 이미지는 <img>, 동영상은 컨트롤 달린 <video>.
//      "보여주는 기능" 의 핵심이라 DOM 으로 단언한다(다운로드 링크만 있으면 실패).
//   3. step 이름을 누르면 그 step 세션으로 건너뛴다.
//   4. step 세션의 메시지 아래에 첨부가 그려진다 — 미디어는 썸네일, 그 밖은 파일 카드.
//   5. 채팅 MessageList 는 동영상 첨부를 인라인 플레이어로 그린다(미션 대화의 사람 업로드).
//   6. 바이트는 목록에 실리지 않고 썸네일이 놓일 때 받아 온다(로더 호출로 확인).

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import MissionEvidencePane from '../src/components/orchestration/MissionEvidencePane.tsx';
import StepSessionPanel from '../src/components/orchestration/StepSessionPanel.tsx';
import MessageList from '../src/components/chat/MessageList.tsx';

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function prepDom() {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');
  // jsdom 에는 Blob URL 이 없다 — 썸네일/플레이어의 src 가 되는 값만 있으면 된다.
  dom.window.URL.createObjectURL = () => 'blob:stub';
  dom.window.URL.revokeObjectURL = () => {};
  globalThis.URL.createObjectURL = dom.window.URL.createObjectURL;
  globalThis.URL.revokeObjectURL = dom.window.URL.revokeObjectURL;
  return dom;
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 15));
  });
}

const step = (key, overrides = {}) => ({
  id: `step-${key}`, step_key: key, title: `Step ${key}`, instructions: '', acceptance_criteria: '', depends_on: [],
  assignee_agent_id: 'a', assignee_name: 'Ralf/EmberDelve · Coder.Muse', assignee_online: true, status: 'done',
  position: 0, plan_version: 1, room_id: `room-${key}`, result_summary: '', artifacts: [], attempt: 1, max_attempts: 2,
  dispatched_at: iso(60_000), started_at: null, finished_at: iso(1000), workspace_folder: '', visit: 1, verdict: '',
  retry_policy: 'auto', recovery_reason: '', last_heartbeat_at: null, confirm_decision: null, activity: null,
  evidence_count: 0, ...overrides,
});

const evidence = (over) => ({
  id: 'att-1', file_name: 'result.png', mime_type: 'image/png', size_bytes: 1234, uploaded_by_type: 'agent',
  uploaded_by_id: 'a', uploaded_by: 'Ralf/EmberDelve · Coder.Muse', created_at: iso(5000), room_id: 'room-build',
  message_id: 'm1', step_id: 'step-build', step_key: 'build', step_title: 'Step build', ...over,
});

function stubApi(t, overrides) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = api[k];
    api[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) api[k] = v;
  });
}

// ── Evidence 탭 ──────────────────────────────────────────────────────────────

test('Evidence 탭은 미디어를 step 별로 묶고 미션 방 항목을 맨 앞에 둔다', async (t) => {
  const dom = prepDom();
  const loads = [];
  stubApi(t, {
    listOrchestrationMissionEvidence: async () => ({
      mission_id: 'm',
      items: [
        evidence({ id: 'att-1' }),
        evidence({ id: 'att-2', file_name: 'playtest.webm', mime_type: 'video/webm' }),
        evidence({ id: 'att-3', file_name: 'human.png', room_id: 'room-mission', step_id: null, step_key: '', step_title: '', uploaded_by_type: 'user', uploaded_by: 'parn' }),
        evidence({ id: 'att-4', file_name: 'ship.png', room_id: 'room-ship', step_id: 'step-ship', step_key: 'ship', step_title: 'Step ship' }),
      ],
    }),
    getOrchestrationStepAttachment: async (stepId, _ws, id) => {
      loads.push(`step:${stepId}:${id}`);
      return { id, file_name: 'x', mime_type: id === 'att-2' ? 'video/webm' : 'image/png', size_bytes: 1, is_media: true, file_data: PNG };
    },
    getChatAttachment: async (roomId, id) => {
      loads.push(`chat:${roomId}:${id}`);
      return { id, filename: 'human.png', mime_type: 'image/png', size_bytes: 1, download_url: '', file_data: PNG };
    },
  });
  const picked = [];
  const view = mount(
    React.createElement(MissionEvidencePane, {
      missionId: 'm', wsId: 'ws', refreshKey: 1,
      steps: [step('build', { position: 0 }), step('ship', { position: 1 })],
      onSelectStep: (id) => picked.push(id),
    }),
  );
  await settle();
  t.after(() => { view.unmount(); dom.cleanup(); });
  const { container } = view;

  const groups = [...container.querySelectorAll('[data-testid="evidence-group"]')];
  assert.equal(groups.length, 3, '미션 방 + step 두 개');
  assert.match(groups[0].textContent, /Mission conversation/, '미션 방 항목이 맨 앞');
  assert.match(groups[1].textContent, /Step build/);
  assert.match(groups[2].textContent, /Step ship/);
  assert.equal(container.querySelectorAll('[data-testid="evidence-thumb"]').length, 4);
  assert.match(container.textContent, /▶ video/, '동영상 썸네일은 재생 표시를 단다');
  assert.match(container.textContent, /parn/, '올린 사람이 보인다');

  // 바이트는 목록이 아니라 썸네일이 놓일 때 받는다 — step 첨부는 step 경로, 미션 방은 채팅 경로.
  assert.ok(loads.includes('step:step-build:att-1'));
  assert.ok(loads.includes('chat:room-mission:att-3'), '미션 방 첨부는 채팅 경로로 읽는다');

  const jump = [...container.querySelectorAll('button')].find((b) => /Step build/.test(b.textContent));
  await act(async () => { jump.click(); });
  assert.deepEqual(picked, ['step-build'], 'step 이름을 누르면 그 세션으로 건너뛴다');
});

test('썸네일을 누르면 라이트박스 — 동영상은 <video controls>, 이미지는 <img>', async (t) => {
  const dom = prepDom();
  stubApi(t, {
    listOrchestrationMissionEvidence: async () => ({
      mission_id: 'm',
      items: [evidence({ id: 'att-1' }), evidence({ id: 'att-2', file_name: 'playtest.webm', mime_type: 'video/webm' })],
    }),
    getOrchestrationStepAttachment: async (_s, _w, id) => ({
      id, file_name: 'x', mime_type: id === 'att-2' ? 'video/webm' : 'image/png', size_bytes: 1, is_media: true, file_data: PNG,
    }),
  });
  const view = mount(React.createElement(MissionEvidencePane, { missionId: 'm', wsId: 'ws', refreshKey: 1, steps: [step('build')], onSelectStep: () => {} }));
  await settle();
  t.after(() => { view.unmount(); dom.cleanup(); });
  const { container } = view;

  const thumbs = [...container.querySelectorAll('[data-testid="evidence-thumb"]')];
  const videoThumb = thumbs.find((b) => /video/.test(b.textContent));
  await act(async () => { videoThumb.click(); });
  const box = container.querySelector('[data-testid="evidence-lightbox"]');
  assert.ok(box, '라이트박스가 열린다');
  assert.equal(Boolean(box.querySelector('video[controls]')), true, '동영상은 컨트롤 달린 플레이어로 재생된다');
  assert.match(box.textContent, /Download/, '원본 다운로드도 가능하다');

  await act(async () => { box.click(); });
  assert.equal(Boolean(container.querySelector('[data-testid="evidence-lightbox"]')), false, '바탕을 누르면 닫힌다');

  const imgThumb = thumbs.find((b) => !/video/.test(b.textContent));
  await act(async () => { imgThumb.click(); });
  const box2 = container.querySelector('[data-testid="evidence-lightbox"]');
  assert.equal(Boolean(box2.querySelector('img')), true, '이미지는 원본 크기 <img>');
  assert.equal(Boolean(box2.querySelector('video')), false);
});

test('바이트는 왔는데 디코드가 안 되면 "깨진 파일"로 말한다 — 영원한 자리표시자가 아니라', async (t) => {
  // 2026-09-26 실제 사고: 에이전트가 아직 저장이 끝나지 않은 캡처를 읽어 올려 JPEG 이
  // 중간에 끊겼다. 그때 썸네일은 영원히 "…" 였고 운영자에게는 "AWB 가 이미지를 못
  // 보여준다"로 보였다 — 파일이 깨진 것과 화면이 고장난 것은 다른 문제이므로 구분해야 한다.
  const dom = prepDom();
  stubApi(t, {
    listOrchestrationMissionEvidence: async () => ({ mission_id: 'm', items: [evidence({ id: 'att-1' })] }),
    getOrchestrationStepAttachment: async (_s, _w, id) => ({
      id, file_name: 'broken.jpg', mime_type: 'image/jpeg', size_bytes: 13676, is_media: true, file_data: PNG,
    }),
  });
  const view = mount(
    React.createElement(MissionEvidencePane, { missionId: 'm', wsId: 'ws', refreshKey: 1, steps: [step('build')], onSelectStep: () => {} }),
  );
  await settle();
  t.after(() => { view.unmount(); dom.cleanup(); });

  const img = view.container.querySelector('[data-testid="evidence-thumb"] img');
  assert.ok(img, '먼저 이미지로 그려 본다');
  await act(async () => {
    img.dispatchEvent(new dom.window.Event('error'));
  });
  assert.ok(
    view.container.querySelector('[data-testid="evidence-thumb-broken"]'),
    '디코드 실패는 깨진 파일이라고 말해야 한다',
  );
  assert.match(view.container.textContent, /깨진 파일/);
});

test('증거가 없으면 어떻게 올리는지 안내한다', async (t) => {
  const dom = prepDom();
  stubApi(t, { listOrchestrationMissionEvidence: async () => ({ mission_id: 'm', items: [] }) });
  const view = mount(React.createElement(MissionEvidencePane, { missionId: 'm', wsId: 'ws', refreshKey: 1, steps: [], onSelectStep: () => {} }));
  await settle();
  t.after(() => { view.unmount(); dom.cleanup(); });
  assert.ok(view.container.querySelector('[data-testid="evidence-empty"]'));
  assert.match(view.container.textContent, /step 방에/);
});

// ── step 세션의 첨부 ────────────────────────────────────────────────────────

test('step 세션은 메시지 아래에 첨부를 그린다 — 미디어는 썸네일, 그 밖은 파일 카드', async (t) => {
  const dom = prepDom();
  stubApi(t, {
    getOrchestrationStepSession: async () => ({
      step_id: 'step-build', step_key: 'build', room_id: 'room-build', has_more: false, next_before_id: null,
      items: [
        {
          id: 'm1', at: iso(5000), kind: 'agent', sender_type: 'agent', sender_id: 'a', sender_name: 'Coder.Muse',
          text: '빌드 결과와 녹화입니다.',
          attachments: [
            { id: 'att-1', file_name: 'result.png', mime_type: 'image/png', size_bytes: 10, is_media: true, uploaded_by_type: 'agent', uploaded_by_id: 'a', uploaded_by: 'Coder.Muse', created_at: iso(5000) },
            { id: 'att-2', file_name: 'playtest.webm', mime_type: 'video/webm', size_bytes: 20, is_media: true, uploaded_by_type: 'agent', uploaded_by_id: 'a', uploaded_by: 'Coder.Muse', created_at: iso(5000) },
            { id: 'att-3', file_name: 'build.log', mime_type: 'text/plain', size_bytes: 3, is_media: false, uploaded_by_type: 'agent', uploaded_by_id: 'a', uploaded_by: 'Coder.Muse', created_at: iso(5000) },
          ],
        },
      ],
    }),
    getOrchestrationStepAttachment: async (_s, _w, id) => ({ id, file_name: 'x', mime_type: 'image/png', size_bytes: 1, is_media: true, file_data: PNG }),
  });
  const view = mount(React.createElement(StepSessionPanel, { step: step('build', { status: 'running' }), wsId: 'ws', events: [], stepTimeoutMinutes: 90, onClose: () => {} }));
  await settle();
  t.after(() => { view.unmount(); dom.cleanup(); });
  const { container } = view;

  const strip = container.querySelector('[data-testid="step-session-attachments"]');
  assert.ok(strip, '첨부 줄이 있다');
  assert.equal(strip.querySelectorAll('[data-testid="evidence-thumb"]').length, 2, '이미지·동영상은 썸네일');
  assert.match(strip.textContent, /build\.log/, '로그 파일은 파일 카드');
  assert.match(strip.textContent, /Download/);
  assert.match(container.textContent, /빌드 결과와 녹화입니다/);
});

// ── 채팅 MessageList 의 동영상 ──────────────────────────────────────────────

test('MessageList 는 동영상 첨부를 인라인 플레이어로 그린다', async (t) => {
  const dom = prepDom();
  stubApi(t, {
    getChatAttachment: async (_room, id) => ({ id, filename: 'demo.webm', mime_type: 'video/webm', size_bytes: 1, download_url: '', file_data: PNG }),
  });
  const view = mount(
    React.createElement(MessageList, {
      participantCount: 2,
      currentUserId: 'me',
      messages: [
        {
          id: 'msg-1', room_id: 'room-m', workspace_id: 'ws', sender_type: 'user', sender_id: 'parn', sender_name: 'parn',
          content: '플레이 녹화', images: [], type: 'message', created_at: iso(1000),
          attachments: [{ id: 'v1', room_id: 'room-m', filename: 'demo.webm', mime_type: 'video/webm', size_bytes: 1, download_url: '' }],
        },
      ],
    }),
  );
  await settle();
  t.after(() => { view.unmount(); dom.cleanup(); });
  const video = view.container.querySelector('[data-testid="chat-video-attachment"]');
  assert.ok(video, '동영상이 <video> 로 그려진다 — 다운로드 카드가 아니라');
  assert.equal(video.tagName, 'VIDEO');
  assert.equal(video.hasAttribute('controls'), true);
  assert.doesNotMatch(view.container.textContent, /Download/, '동영상에는 파일 카드가 붙지 않는다');
});
