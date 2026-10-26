import { t as translate } from '../../i18n/core';
/**
 * CLI 메모리 내보내기·가져오기·적용 — 순수 함수(docs/cli-memory.md "Import / Export", "적용").
 *
 * 번들은 절대 경로가 아니라 **위치**로 파일을 적는다: (CLI, 홈, 기준점, 상대 경로). 기준점은
 *   - `home`        CLI 홈 기준(`CLAUDE.md`, `rules/x.md`, `memories/MEMORY.md`)
 *   - `project`     프로젝트 폴더 기준(`AGENTS.md`, `.claude/rules/x.md`) — 프로젝트는 id 로 대응한다
 *   - `claude_auto` Claude auto memory(`<home>/projects/<key>/memory/<file>`) — key 는 대상 장비의
 *                   프로젝트 폴더로 다시 계산한다
 * 이라서 다른 장비(경로가 다른 Windows 호스트 포함)로 옮겨도 같은 자리를 찾는다. 대상이 그 장비에서
 * 선언된 위치가 아니면 계획에서 `unmapped` 로 남기고 쓰지 않는다 — 매니저도 같은 판정을 한 번 더 한다.
 */

import type {
  CliMemorySnapshot,
  MemoryBatchOp,
  MemoryFileInfo,
  MemoryFormat,
  MemoryHostSnapshot,
  MemoryKind,
  MemoryScope,
} from '../../types';
import {
  basenameOf,
  blockId,
  claudeProjectKey,
  dirnameOf,
  entriesToMarkdown,
  findManagedBlock,
  joinHostPath,
  markdownToEntries,
  mergeEntries,
  parseEntries,
  relativeHostPath,
  serializeEntries,
  upsertManagedBlock,
} from './memoryFormat.logic';

export const BUNDLE_FORMAT = 'awb-cli-memory';
export const BUNDLE_VERSION = 1;

export type BundleAnchor = 'home' | 'project' | 'claude_auto';

export interface BundleFile {
  cli: string;
  /** `operator` | `session:<credential>` | `profile:<name>` */
  home: string;
  anchor: BundleAnchor;
  /** `/` 로 적은 상대 경로(claude_auto 는 memory 디렉터리 안의 파일 이름). */
  rel: string;
  project_id: string | null;
  project_name: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  format: MemoryFormat;
  label: string;
  source_path: string;
  hash: string | null;
  mtime: string | null;
  content: string;
}

export interface MemoryBundle {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exported_at: string;
  source: { manager_id: string; manager_name: string; hostname: string; platform: string };
  files: BundleFile[];
}

/** 파일 하나의 이식 가능한 위치. 못 정하면 null(그 파일은 내보내지 않는다). */
export function locateForBundle(snapshot: MemoryHostSnapshot, cli: CliMemorySnapshot, file: MemoryFileInfo): Omit<BundleFile, 'content' | 'cli' | 'scope' | 'kind' | 'format' | 'label' | 'source_path' | 'hash' | 'mtime'> | null {
  const platform = snapshot.platform;
  const home = cli.homes.find((h) => h.id === file.home_id);
  const project = file.project_dir ? snapshot.project_dirs.find((p) => p.path === file.project_dir) ?? null : null;
  if ((file.kind === 'auto_index' || file.kind === 'auto_topic') && file.group.startsWith('auto:') && project) {
    return { home: file.home_id, anchor: 'claude_auto', rel: basenameOf(file.path), project_id: project.project_id, project_name: project.project_name };
  }
  if (home) {
    const rel = relativeHostPath(platform, home.path, file.path);
    if (rel !== null) return { home: file.home_id, anchor: 'home', rel, project_id: null, project_name: null };
  }
  if (project) {
    const rel = relativeHostPath(platform, project.path, file.path);
    if (rel !== null) return { home: file.home_id, anchor: 'project', rel, project_id: project.project_id, project_name: project.project_name };
  }
  return null;
}

/**
 * 내보내기. 고른 CLI 의 실제 파일(없는 자리·공유 사본 제외)을 담는다. 내용이 생략·잘린 파일은 호출자가
 * 미리 전문으로 채워 둔다(`contentOf`).
 */
export function buildBundle(
  snapshot: MemoryHostSnapshot,
  opts: { clis?: readonly string[]; contentOf?: (cli: string, file: MemoryFileInfo) => string | null; now?: Date } = {},
): { bundle: MemoryBundle; skipped: string[] } {
  const files: BundleFile[] = [];
  const skipped: string[] = [];
  for (const cli of snapshot.clis) {
    if (opts.clis && !opts.clis.includes(cli.cli)) continue;
    for (const file of cli.files) {
      if (!file.exists || file.shared_with) continue;
      const content = opts.contentOf ? opts.contentOf(cli.cli, file) : file.content;
      if (content === null || content === undefined) {
        skipped.push(file.display_path);
        continue;
      }
      const loc = locateForBundle(snapshot, cli, file);
      if (!loc) {
        skipped.push(file.display_path);
        continue;
      }
      files.push({
        ...loc,
        cli: cli.cli,
        scope: file.scope,
        kind: file.kind,
        format: file.format,
        label: file.label,
        source_path: file.path,
        hash: file.hash,
        mtime: file.mtime,
        content,
      });
    }
  }
  return {
    bundle: {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exported_at: (opts.now ?? new Date()).toISOString(),
      source: { manager_id: snapshot.manager_id, manager_name: snapshot.manager_name, hostname: snapshot.hostname, platform: snapshot.platform },
      files,
    },
    skipped,
  };
}

/** 사람이 읽는 한 장짜리 markdown — 검토·공유용(가져오기는 JSON 번들로). */
export function bundleToMarkdown(bundle: MemoryBundle): string {
  const out: string[] = [translate('# CLI memory — {0} ({1})', { 0: bundle.source.manager_name, 1: bundle.source.hostname }), '', translate('Exported {0}', { 0: bundle.exported_at }), ''];
  let cli = '';
  for (const f of bundle.files) {
    if (f.cli !== cli) {
      cli = f.cli;
      out.push(`## ${cli}`, '');
    }
    const where = f.anchor === 'home' ? `${f.home}/${f.rel}` : f.anchor === 'project' ? `${f.project_name}/${f.rel}` : translate('{0} auto memory/{1}', { 0: f.project_name, 1: f.rel });
    out.push(`### ${f.label} — \`${where}\``, '', '````markdown', f.content.replace(/\s+$/, ''), '````', '');
  }
  return out.join('\n');
}

export function parseBundle(text: string): MemoryBundle {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(translate('Not a JSON file.'));
  }
  if (!data || data.format !== BUNDLE_FORMAT) throw new Error(translate('Not an AWB CLI memory bundle.'));
  if (typeof data.version !== 'number' || data.version > BUNDLE_VERSION) throw new Error(translate('Unsupported bundle version {0}.', { 0: data.version }));
  if (!Array.isArray(data.files)) throw new Error(translate('The bundle has no files.'));
  const files: BundleFile[] = [];
  for (const f of data.files) {
    if (!f || typeof f.cli !== 'string' || typeof f.rel !== 'string' || typeof f.content !== 'string') continue;
    if (!['home', 'project', 'claude_auto'].includes(f.anchor)) continue;
    if (f.rel.split('/').some((part: string) => part === '..' || part === '')) continue;
    files.push({
      cli: f.cli,
      home: typeof f.home === 'string' ? f.home : 'operator',
      anchor: f.anchor,
      rel: f.rel,
      project_id: typeof f.project_id === 'string' ? f.project_id : null,
      project_name: typeof f.project_name === 'string' ? f.project_name : null,
      scope: f.scope === 'project' ? 'project' : 'global',
      kind: f.kind,
      format: f.format === 'section_entries' ? 'section_entries' : 'markdown',
      label: typeof f.label === 'string' ? f.label : f.rel,
      source_path: typeof f.source_path === 'string' ? f.source_path : '',
      hash: typeof f.hash === 'string' ? f.hash : null,
      mtime: typeof f.mtime === 'string' ? f.mtime : null,
      content: f.content,
    });
  }
  return {
    format: BUNDLE_FORMAT,
    version: data.version,
    exported_at: typeof data.exported_at === 'string' ? data.exported_at : '',
    source: {
      manager_id: String(data.source?.manager_id ?? ''),
      manager_name: String(data.source?.manager_name ?? ''),
      hostname: String(data.source?.hostname ?? ''),
      platform: String(data.source?.platform ?? ''),
    },
    files,
  };
}

// ─── 대상 찾기 ───────────────────────────────────────────────────────────

/** 대상 장비에서 이 경로에 쓸 수 있는가 — 선언된 파일이거나 선언된 디렉터리 바로 아래. */
export function targetSlot(cli: CliMemorySnapshot, path: string): { file: MemoryFileInfo | null; allowed: boolean } {
  const file = cli.files.find((f) => f.path === path) ?? null;
  if (file) return { file, allowed: file.editable };
  const dir = dirnameOf(path);
  return { file: null, allowed: cli.dirs.some((d) => d.path === dir) };
}

function projectDirOn(target: MemoryHostSnapshot, projectId: string | null, projectName: string | null): string | null {
  if (projectId) {
    const hit = target.project_dirs.find((p) => p.project_id === projectId);
    if (hit) return hit.path;
  }
  if (projectName) {
    const byName = target.project_dirs.filter((p) => p.project_name === projectName);
    if (byName.length === 1) return byName[0].path;
  }
  return null;
}

/** 번들 파일 하나가 대상 장비에서 갈 경로. `homeMode: 'operator'` 면 세션 홈 파일도 운영자 홈으로 모은다. */
export function resolveTargetPath(target: MemoryHostSnapshot, file: BundleFile, opts: { homeMode?: 'same' | 'operator'; cli?: string } = {}): { path: string | null; reason?: string } {
  const cli = target.clis.find((c) => c.cli === (opts.cli ?? file.cli));
  if (!cli || !cli.detected) return { path: null, reason: translate('{0} is not on this host', { 0: opts.cli ?? file.cli }) };
  const homeId = opts.homeMode === 'operator' ? 'operator' : file.home;
  const home = cli.homes.find((h) => h.id === homeId);
  if (file.anchor === 'home') {
    if (!home) return { path: null, reason: translate('home {0} does not exist here', { 0: homeId }) };
    return { path: joinHostPath(target.platform, home.path, file.rel) };
  }
  const dir = projectDirOn(target, file.project_id, file.project_name);
  if (!dir) return { path: null, reason: translate('project {0} has no folder on this host', { 0: file.project_name || file.project_id }) };
  if (file.anchor === 'project') return { path: joinHostPath(target.platform, dir, file.rel) };
  if (!home) return { path: null, reason: translate('home {0} does not exist here', { 0: homeId }) };
  return { path: joinHostPath(target.platform, home.path, `projects/${claudeProjectKey(dir)}/memory/${file.rel}`) };
}

// ─── 가져오기 계획 ───────────────────────────────────────────────────────

export type ImportAction = 'create' | 'update' | 'same' | 'unmapped';
export type ConflictStrategy = 'overwrite' | 'skip' | 'merge';

export interface ImportPlanItem {
  file: BundleFile;
  action: ImportAction;
  target_path: string | null;
  target: MemoryFileInfo | null;
  reason?: string;
}

export function planImport(target: MemoryHostSnapshot, bundle: MemoryBundle, opts: { homeMode?: 'same' | 'operator' } = {}): ImportPlanItem[] {
  return bundle.files.map((file) => {
    const resolved = resolveTargetPath(target, file, opts);
    if (!resolved.path) return { file, action: 'unmapped' as const, target_path: null, target: null, reason: resolved.reason };
    const cli = target.clis.find((c) => c.cli === file.cli) as CliMemorySnapshot;
    const slot = targetSlot(cli, resolved.path);
    if (!slot.allowed) {
      return { file, action: 'unmapped' as const, target_path: resolved.path, target: slot.file, reason: translate('not a memory location on this host') };
    }
    if (!slot.file || !slot.file.exists) return { file, action: 'create' as const, target_path: resolved.path, target: slot.file };
    const same = slot.file.content !== null ? slot.file.content === file.content : slot.file.hash === file.hash;
    return { file, action: same ? 'same' as const : 'update' as const, target_path: resolved.path, target: slot.file };
  });
}

/** 합치기 — 항목 파일은 새 항목만 덧붙이고, markdown 은 번들 내용을 관리 블록으로 넣는다. */
export function mergeContent(existing: string, incoming: string, format: MemoryFormat, id: string): string {
  if (format === 'section_entries') return serializeEntries(mergeEntries(parseEntries(existing), parseEntries(incoming)).entries);
  if (existing.trim() === incoming.trim()) return existing;
  return upsertManagedBlock(existing, id, incoming);
}

export function importOps(plan: readonly ImportPlanItem[], strategy: ConflictStrategy, bundle: MemoryBundle): MemoryBatchOp[] {
  const ops: MemoryBatchOp[] = [];
  for (const item of plan) {
    if (!item.target_path || item.action === 'unmapped' || item.action === 'same') continue;
    if (item.action === 'create') {
      ops.push({ op: 'write', cli: item.file.cli, path: item.target_path, content: item.file.content, base_hash: null, reason: 'import' });
      continue;
    }
    if (strategy === 'skip') continue;
    const current = item.target?.content ?? '';
    const content = strategy === 'merge'
      ? mergeContent(current, item.file.content, item.file.format, blockId(['import', bundle.source.hostname || bundle.source.manager_id, item.file.cli, item.file.rel]))
      : item.file.content;
    if (content === current) continue;
    ops.push({ op: 'write', cli: item.file.cli, path: item.target_path, content, base_hash: item.target?.hash ?? null, reason: 'import' });
  }
  return ops;
}

// ─── 다른 CLI 에 적용 ────────────────────────────────────────────────────

export type ApplyMode = 'block' | 'replace' | 'entries';

/** 원본을 대상 형식으로 옮긴다. 항목 ↔ markdown 은 서로 바꿔 적는다. */
export function convertContent(source: string, from: MemoryFormat, to: MemoryFormat): string {
  if (from === to) return source;
  if (from === 'section_entries') return entriesToMarkdown(parseEntries(source));
  return serializeEntries(markdownToEntries(source));
}

/** 이 대상에 기본으로 쓸 방식 — 항목 파일은 항목 합치기, 그 밖에는 관리 블록. */
export function defaultApplyMode(target: MemoryFileInfo): ApplyMode {
  return target.format === 'section_entries' ? 'entries' : 'block';
}

export interface ApplySource {
  cli: string;
  host: string;
  file: MemoryFileInfo;
  content: string;
}

/** 적용 결과 내용. 대상이 없으면 빈 파일에서 시작한다. */
export function applyContent(source: ApplySource, target: MemoryFileInfo, mode: ApplyMode): string {
  const current = target.exists ? target.content ?? '' : '';
  const converted = convertContent(source.content, source.file.format, target.format);
  if (mode === 'replace') return converted;
  if (mode === 'entries' || target.format === 'section_entries') {
    const incoming = source.file.format === 'section_entries' ? parseEntries(source.content) : markdownToEntries(source.content);
    return serializeEntries(mergeEntries(parseEntries(current), incoming).entries);
  }
  const body = source.file.format === 'section_entries' ? entriesToMarkdown(parseEntries(source.content)) : source.content;
  return upsertManagedBlock(current, applyBlockId(source), body);
}

export function applyBlockId(source: ApplySource): string {
  return blockId(['from', source.host, source.cli, basenameOf(source.file.path)]);
}

/** 대상에 이미 같은 출처 블록이 있는가(화면이 "다시 적용하면 갱신" 을 알린다). */
export function hasAppliedBlock(source: ApplySource, target: MemoryFileInfo): boolean {
  return !!target.content && findManagedBlock(target.content, applyBlockId(source)) !== null;
}

/**
 * 적용 후보 — 같은 범위(전역 ↔ 전역, 같은 프로젝트끼리)의 사람이 쓰는 지침·규칙·항목 파일. 원본 자신과
 * 다른 홈의 공유 사본, CLI 가 다시 만드는 파일은 뺀다.
 */
export function applyCandidates(target: MemoryHostSnapshot, source: { cli: string; file: MemoryFileInfo; sameHost: boolean; projectId: string | null }): Array<{ cli: CliMemorySnapshot; file: MemoryFileInfo }> {
  const out: Array<{ cli: CliMemorySnapshot; file: MemoryFileInfo }> = [];
  const projectDir = source.projectId ? target.project_dirs.find((p) => p.project_id === source.projectId)?.path ?? null : null;
  for (const cli of target.clis.filter((c) => c.detected)) {
    for (const file of cli.files) {
      if (file.shared_with || !file.editable) continue;
      if (file.kind === 'generated' || file.kind === 'knowledge' || file.kind === 'auto_index') continue;
      if (source.sameHost && file.path === source.file.path) continue;
      if (source.file.scope === 'global' ? file.scope !== 'global' : file.project_dir !== projectDir) continue;
      if (file.kind === 'auto_topic' && !file.exists) continue;
      out.push({ cli, file });
    }
  }
  return out;
}
