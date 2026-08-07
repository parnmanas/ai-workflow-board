// 티켓 ebe97316 — TicketDuplicateService의 이중 chat 게이트를 outreach(reddit/github)
// kind로 일반화한 회귀 방지 테스트. 무거운 e2e 픽스처(bootApp/REST/VirtualAgent) 없이
// DataSource + TicketDuplicateService만 직접 구성하는 confirmed-duplicate-correction.test.mjs
// 패턴을 따른다 — assess()/parseProvenance()는 순수 서비스 메서드라 이걸로 충분하다.
//
// 아래 두 테스트는 1차 리뷰 지적(related_ticket_id를 인위적으로 채워 공백을 가린다는
// 지적)에 대응해, OutreachIngestService._createTicket이 실제로 만드는 조건(동일 채널,
// 빈 related_ticket_id, 서로 다른 문구)을 재현한다. source_chat_room_id를 채널 id로
// 재사용하는 프로듀서 쪽 배선은 아직 없지만(별도 티켓 — 핸드오프 코멘트 참고), 배선됐다고
// 가정했을 때 이 서비스의 매칭/신뢰도 로직이 올바른지는 여기서 독립적으로 검증 가능하다.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(dir, '..', 'dist');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-outreach-duplicate-gate-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(dist, 'db.js'));
const entities = await import('file://' + path.join(dist, 'entities', 'index.js'));
const { TicketDuplicateService } = await import('file://' + path.join(dist, 'modules', 'tickets', 'ticket-duplicate.service.js'));
const { DataSource } = await import('typeorm');
const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

after(async () => {
  await ds.destroy();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('parseProvenance는 chat 외 explicit outreach kind(reddit/github)를 그대로 보존한다', () => {
  const service = new TicketDuplicateService(ds);
  assert.equal(service.parseProvenance({ title: 't', source_kind: 'reddit' }).source_kind, 'reddit');
  assert.equal(service.parseProvenance({ title: 't', source_kind: 'GitHub' }).source_kind, 'github');
  assert.equal(
    service.parseProvenance({ title: 't' }).source_kind,
    '',
    'kind/room/legacy marker가 전혀 없으면 여전히 게이트를 닫는 빈 kind를 반환한다',
  );
  assert.equal(
    service.parseProvenance({ title: 't', source_chat_room_id: 'room-x' }).source_kind,
    'chat',
    'room만 있는 legacy 케이스는 여전히 chat으로 취급한다',
  );
});

test('assess()는 outreach kind에서도 이중 게이트를 통과하고 동일 kind끼리만 매칭한다', async () => {
  const workspace = await ds.getRepository(entities.Workspace).save({ name: 'ws-outreach-gate' });
  const board = await ds.getRepository(entities.Board).save({ workspace_id: workspace.id, name: 'board' });
  const column = await ds.getRepository(entities.BoardColumn).save({
    workspace_id: workspace.id, board_id: board.id, name: 'To Do', position: 0, kind: 'active',
  });
  const anchor = randomUUID();

  const redditCanonical = await ds.getRepository(entities.Ticket).save({
    workspace_id: workspace.id, column_id: column.id,
    title: 'Artifact pipeline regression',
    source_kind: 'reddit', related_ticket_id: anchor,
  });
  const githubDecoy = await ds.getRepository(entities.Ticket).save({
    workspace_id: workspace.id, column_id: column.id,
    title: 'Artifact pipeline regression',
    source_kind: 'github', related_ticket_id: anchor,
  });

  const service = new TicketDuplicateService(ds);

  const untagged = await service.assess(workspace.id, { title: 'Artifact pipeline regression' });
  assert.deepEqual(untagged.candidates, [], 'source_kind이 없는 intake는 여전히 전체 게이트가 닫혀 있다');

  const redditAssessment = await service.assess(workspace.id, {
    title: '[Bug] Artifact pipeline regression',
    source_kind: 'reddit',
    related_ticket_id: anchor,
  });
  assert.equal(redditAssessment.source_kind, 'reddit');
  assert.equal(
    redditAssessment.canonical_ticket_id, redditCanonical.id,
    '동일 kind + 동일 related_ticket_id 앵커 + 정규화 제목 일치는 자동 링크된다',
  );
  assert.equal(
    redditAssessment.candidates.some((c) => c.ticket_id === githubDecoy.id), false,
    'kind가 다른 github 후보는 앵커/제목이 같아도 절대 매칭되지 않는다',
  );

  const githubAssessment = await service.assess(workspace.id, {
    title: '[Bug] Artifact pipeline regression',
    source_kind: 'github',
    related_ticket_id: anchor,
  });
  assert.equal(githubAssessment.canonical_ticket_id, githubDecoy.id, 'github 리포트는 github 후보하고만 매칭된다');
});

test('same_channel 앵커: 실제 outreach 생성 조건(동일 채널, 빈 related_ticket_id, 다른 문구)은 60점 후보로만 잡히고 자동링크되지 않는다', async () => {
  const workspace = await ds.getRepository(entities.Workspace).save({ name: 'ws-outreach-channel' });
  const board = await ds.getRepository(entities.Board).save({ workspace_id: workspace.id, name: 'board' });
  const column = await ds.getRepository(entities.BoardColumn).save({
    workspace_id: workspace.id, board_id: board.id, name: 'To Do', position: 0, kind: 'active',
  });
  const channelId = randomUUID();

  // OutreachIngestService._createTicket이 오늘 실제로 채우는 필드(source_kind +
  // 'outreach'/'source:<kind>' 라벨)만 시딩한다. source_chat_room_id는 채널 id를
  // 담는다고 가정한 값이다 — 프로듀서 배선 자체는 이 티켓 범위 밖(핸드오프 코멘트 참고).
  const candidate = await ds.getRepository(entities.Ticket).save({
    workspace_id: workspace.id, column_id: column.id,
    title: 'App crashes immediately on launch',
    source_kind: 'reddit', source_chat_room_id: channelId,
    labels: JSON.stringify(['outreach', 'source:reddit']),
  });

  const service = new TicketDuplicateService(ds);
  const assessment = await service.assess(workspace.id, {
    title: 'Cannot start the app, it crashes every time',
    source_kind: 'reddit',
    source_chat_room_id: channelId,
    labels: ['outreach', 'source:reddit'],
  });

  assert.equal(
    assessment.canonical_ticket_id, null,
    '채널만 같고 문구가 다르면 공용 provenance 라벨만으로는 100점 자동링크되면 안 된다',
  );
  const match = assessment.candidates.find(c => c.ticket_id === candidate.id);
  assert.ok(match, '완전히 무시(no-op)되지 않고 반드시 후보로는 잡혀야 한다');
  assert.equal(match.confidence, 60);
  assert.deepEqual(match.matched_signals, ['same_channel']);
  assert.equal(assessment.ambiguous, true, '사람 확인이 필요한 애매한 후보로 표시되어야 한다');
});

test('same_channel + provenance 라벨을 제외하고도 실질적으로 겹치는 라벨이 있으면 여전히 100점 자동링크된다', async () => {
  const workspace = await ds.getRepository(entities.Workspace).save({ name: 'ws-outreach-channel-corroborated' });
  const board = await ds.getRepository(entities.Board).save({ workspace_id: workspace.id, name: 'board' });
  const column = await ds.getRepository(entities.BoardColumn).save({
    workspace_id: workspace.id, board_id: board.id, name: 'To Do', position: 0, kind: 'active',
  });
  const channelId = randomUUID();

  const candidate = await ds.getRepository(entities.Ticket).save({
    workspace_id: workspace.id, column_id: column.id,
    title: 'App crashes immediately on launch',
    source_kind: 'reddit', source_chat_room_id: channelId,
    labels: JSON.stringify(['outreach', 'source:reddit', 'crash-on-launch']),
  });

  const service = new TicketDuplicateService(ds);
  const assessment = await service.assess(workspace.id, {
    title: 'Cannot start the app, it crashes every time',
    source_kind: 'reddit',
    source_chat_room_id: channelId,
    labels: ['outreach', 'source:reddit', 'crash-on-launch'],
  });

  assert.equal(
    assessment.canonical_ticket_id, candidate.id,
    'provenance 라벨을 빼고도 실제로 겹치는 라벨(crash-on-launch)이 남으면 정상적으로 자동링크되어야 한다',
  );
});
