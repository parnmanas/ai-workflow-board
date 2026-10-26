import { t as translate } from '../../i18n/core';
/**
 * Knowledge 화면 — 순수 함수(docs/skills.md "Knowledge").
 *
 * 지식은 두 범위로 정리된다:
 *   - 공용     — 계정의 모든 Agent: 공용 메모리(Account.knowledge_memory) + 공용 범위 skill
 *   - 프로젝트 — 그 프로젝트의 작업: 프로젝트 메모리(Project.instructions) + 프로젝트 범위 skill
 * (skill 은 한 실행 신원에만 거는 "특정 실행" 범위도 있다.)
 *
 * 티켓·미션은 AWB 가 지시문에 실어 보낸다. 사람이 직접 여는 CLI 세션은 AWB 가 지시문을 쓰지 않으므로,
 * 공용 지식을 호스트의 CLI 전역 메모리 파일에 관리 블록으로 동기화한다 — 여기 함수가 그 블록과 대상을 정한다.
 */

import type { CliMemorySnapshot, MemoryBatchOp, MemoryFileInfo, MemoryHostSnapshot, Project, SkillAssignment, SkillAssignmentScope } from '../../types';
import { findManagedBlock, upsertManagedBlock } from '../memory/memoryFormat.logic';

export interface AssignmentGroup {
  key: string;
  scope: SkillAssignmentScope;
  title: string;
  subtitle: string;
  project_id: string | null;
  items: SkillAssignment[];
}

/** 배정을 범위별로 묶는다 — 공용 먼저, 프로젝트는 이름순(배정이 없는 프로젝트도 자리를 낸다), 특정 실행 마지막. */
export function groupAssignments(assignments: readonly SkillAssignment[], projects: readonly Pick<Project, 'id' | 'name'>[]): AssignmentGroup[] {
  const sortItems = (items: SkillAssignment[]) => items.sort((a, b) => a.skill_slug.localeCompare(b.skill_slug));
  const groups: AssignmentGroup[] = [{
    key: 'account',
    scope: 'account',
    title: translate('Shared'),
    subtitle: translate('Every agent in this account'),
    project_id: null,
    items: sortItems(assignments.filter((a) => a.scope === 'account')),
  }];
  const projectIds = new Set<string>(projects.map((p) => p.id));
  for (const a of assignments) if (a.scope === 'project' && a.project_id) projectIds.add(a.project_id);
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? assignments.find((a) => a.project_id === id)?.project_name ?? id.slice(0, 8);
  for (const id of Array.from(projectIds).sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
    groups.push({
      key: `project:${id}`,
      scope: 'project',
      title: nameOf(id),
      subtitle: translate('Tickets and mission steps of this project'),
      project_id: id,
      items: sortItems(assignments.filter((a) => a.scope === 'project' && a.project_id === id)),
    });
  }
  const runtime = assignments.filter((a) => a.scope === 'runtime');
  if (runtime.length) {
    groups.push({
      key: 'runtime',
      scope: 'runtime',
      title: translate('Specific runtime'),
      subtitle: translate('One runtime identity only (host · CLI · folder · credential)'),
      project_id: null,
      items: sortItems(runtime),
    });
  }
  return groups;
}

export function assignmentTargetLabel(a: SkillAssignment): string {
  if (a.scope === 'account') return translate('Shared');
  if (a.scope === 'project') return a.project_name || a.project_id?.slice(0, 8) || translate('Project');
  return a.target_label || a.runtime_key?.slice(0, 15) || translate('Runtime');
}

// ─── 호스트 동기화(사람이 여는 CLI 세션용) ─────────────────────────────────

export function knowledgeBlockId(accountId: string): string {
  return `awb-knowledge:${accountId}`;
}

export interface SharedSkillLine {
  slug: string;
  name: string;
  version: number | null;
}

/**
 * 호스트 CLI 전역 메모리 파일에 넣을 공용 지식 블록. 공용 메모리 본문 + 공용 skill 목차 + 본문을 꺼내는 법.
 * 프로젝트 지식은 넣지 않는다(전역 파일은 모든 폴더에서 읽힌다) — 대신 MCP 로 꺼내는 법을 적는다.
 */
export function sharedKnowledgeBody(args: { accountName: string; memory: string; skills: readonly SharedSkillLine[] }): string {
  const parts = [`# ${args.accountName} — shared knowledge (managed by AWB; edit it in AWB → Knowledge → Memory)`];
  const memory = args.memory.trim();
  if (memory) parts.push(memory);
  if (args.skills.length) {
    parts.push([
      '## Skills',
      'Read a skill\'s full text with the AWB MCP tool `get_skill` (`{ slug }`) before using it.',
      ...args.skills.map((s) => `- ${s.slug}${s.version ? ` (v${s.version})` : ''}${s.name && s.name !== s.slug ? ` — ${s.name}` : ''}`),
    ].join('\n'));
  }
  parts.push('When working in a project, call the AWB MCP tool `get_knowledge` with `{ project_id }` (or `{ ticket_id }`) for that project\'s memory and skills.');
  return parts.join('\n\n');
}

export interface SyncTarget {
  cli: CliMemorySnapshot;
  file: MemoryFileInfo;
}

/**
 * 동기화 대상 — 감지된 CLI 마다 전역 지침 파일(사람이 쓰는 markdown, 매 세션 로드). 운영자 홈과 AWB 세션 홈
 * · 프로필 홈을 모두 포함한다(credential 세션은 운영자 홈 파일을 못 읽는다). 링크로 공유된 사본, 읽기 전용,
 * 항목 형식(Hermes — 글자 상한이 작다)은 뺀다.
 */
export function syncTargets(snapshot: MemoryHostSnapshot): SyncTarget[] {
  const out: SyncTarget[] = [];
  for (const cli of snapshot.clis.filter((c) => c.detected)) {
    for (const file of cli.files) {
      if (file.scope !== 'global' || file.kind !== 'instructions' || file.format !== 'markdown') continue;
      if (file.shared_with || !file.editable || file.link_target) continue;
      // override 가 있으면 AGENTS.md 는 읽히지 않는다(Codex) — 그때는 override 쪽이 대상이다.
      if (file.loaded !== 'always') continue;
      out.push({ cli, file });
    }
  }
  return out;
}

export type SyncStatus = 'current' | 'outdated' | 'missing' | 'unknown';

/** 그 파일에 지금 블록이 최신으로 들어 있는가. 내용이 생략된 큰 파일은 모른다. */
export function syncStatus(file: MemoryFileInfo, id: string, body: string): SyncStatus {
  if (!file.exists) return 'missing';
  if (file.content === null || file.truncated || file.omitted) return 'unknown';
  const block = findManagedBlock(file.content, id);
  if (block === null) return 'missing';
  return block.trim() === body.trim() ? 'current' : 'outdated';
}

/** 고른 대상에 블록을 넣는/갱신하는 batch. 이미 최신이면 뺀다. 대상의 나머지 내용은 그대로 둔다. */
export function syncOps(targets: readonly SyncTarget[], id: string, body: string): MemoryBatchOp[] {
  const ops: MemoryBatchOp[] = [];
  for (const { cli, file } of targets) {
    if (syncStatus(file, id, body) === 'current') continue;
    const current = file.exists ? file.content ?? '' : '';
    ops.push({
      op: 'write',
      cli: cli.cli,
      path: file.path,
      content: upsertManagedBlock(current, id, body),
      base_hash: file.exists ? file.hash : null,
      reason: 'knowledge',
    });
  }
  return ops;
}
