/**
 * CLI Memory 화면 상태 — 순수 함수. 스냅샷을 쓰기 결과로 고치고, 파일 트리를 묶는다.
 */

import type { CliMemorySnapshot, MemoryDirInfo, MemoryFileInfo, MemoryHostSnapshot, MemoryKind } from '../../types';
import { basenameOf, estimateTokens, joinHostPath } from './memoryFormat.logic';

/** 쓰기 결과로 스냅샷의 그 파일을 바꾼다(없으면 넣는다). 분석은 바뀐 스냅샷으로 다시 돈다. */
export function patchSnapshotFile(snapshot: MemoryHostSnapshot, cli: string, info: MemoryFileInfo): MemoryHostSnapshot {
  return {
    ...snapshot,
    clis: snapshot.clis.map((c) => {
      if (c.cli !== cli) return c;
      const i = c.files.findIndex((f) => f.path === info.path && f.home_id === info.home_id);
      const files = i >= 0 ? c.files.map((f, j) => (j === i ? info : f)) : [...c.files, info];
      return { ...c, files };
    }),
  };
}

/** 원래 없을 수 있는 파일(주제·규칙·생성물)은 목록에서 빼고, 자리(전역 지침 등)는 "없음" 으로 남긴다. */
const REMOVE_ON_DELETE: ReadonlySet<MemoryKind> = new Set(['auto_topic', 'rules', 'generated', 'knowledge']);

export function markSnapshotFileDeleted(snapshot: MemoryHostSnapshot, cli: string, path: string): MemoryHostSnapshot {
  return {
    ...snapshot,
    clis: snapshot.clis.map((c) => {
      if (c.cli !== cli) return c;
      const files = c.files.flatMap((f) => {
        if (f.path !== path) return [f];
        if (REMOVE_ON_DELETE.has(f.kind)) return [];
        return [{ ...f, exists: false, content: null, hash: null, size: 0, mtime: null, truncated: false, omitted: false, link_target: null, missing_paths: undefined }];
      });
      return { ...c, files };
    }),
  };
}

/** 선언된 디렉터리에 새 파일 자리를 만든다(아직 장비에는 없다 — 저장하면 생긴다). */
export function newFileInDir(platform: string, dir: MemoryDirInfo, name: string): MemoryFileInfo {
  const path = joinHostPath(platform, dir.path, name);
  return {
    home_id: dir.home_id,
    path,
    display_path: joinHostPath(platform, dir.display_path, name),
    scope: dir.scope,
    kind: dir.kind,
    format: 'markdown',
    label: dir.kind === 'auto_topic' ? `Auto memory · ${name.replace(/\.md$/i, '')}` : `${dir.label} · ${name.replace(/\.md$/i, '')}`,
    group: dir.group,
    project_dir: dir.project_dir,
    loaded: dir.kind === 'auto_topic' ? 'on_demand' : 'always',
    load_limit_lines: null,
    char_limit: null,
    editable: true,
    exists: false,
    size: 0,
    mtime: null,
    hash: null,
    content: null,
    truncated: false,
    omitted: false,
    link_target: null,
    shared_with: null,
  };
}

export interface TreeGroup {
  key: string;
  title: string;
  subtitle: string;
  files: MemoryFileInfo[];
  dirs: MemoryDirInfo[];
}

const KIND_ORDER: Record<string, number> = {
  instructions: 0, persona: 1, entries: 2, rules: 3, auto_index: 4, auto_topic: 5, generated: 6, knowledge: 7,
};

function projectName(snapshot: MemoryHostSnapshot, dir: string | null): string | null {
  if (!dir) return null;
  return snapshot.project_dirs.find((p) => p.path === dir)?.project_name ?? null;
}

/** 그룹 이름 — `global` / `project:<dir>` / `auto:<key>` / `memories` / `knowledge`. */
export function groupTitle(snapshot: MemoryHostSnapshot, group: string, sample: { project_dir: string | null } | undefined): { title: string; subtitle: string } {
  if (group === 'global') return { title: 'Global', subtitle: 'Applies to every session' };
  if (group === 'memories') return { title: 'Generated memories', subtitle: 'Distilled by the CLI from past sessions' };
  if (group === 'knowledge') return { title: 'Knowledge items', subtitle: 'Collected by the CLI' };
  if (group.startsWith('project:')) {
    const dir = group.slice('project:'.length);
    return { title: projectName(snapshot, dir) || basenameOf(dir), subtitle: dir };
  }
  if (group.startsWith('auto:')) {
    const key = group.slice('auto:'.length);
    const dir = sample?.project_dir ?? null;
    return { title: `Auto memory · ${projectName(snapshot, dir) || (dir ? basenameOf(dir) : key)}`, subtitle: dir || key };
  }
  return { title: group, subtitle: '' };
}

/**
 * 한 CLI × 홈의 파일 트리. 다른 홈과 공유된 사본은 빼고(그 홈에서 보인다), 검색어가 있으면 이름·경로·내용으로 거른다.
 */
export function treeGroups(snapshot: MemoryHostSnapshot, cli: CliMemorySnapshot, homeId: string, query = ''): TreeGroup[] {
  const q = query.trim().toLowerCase();
  const match = (f: MemoryFileInfo) => !q
    || f.label.toLowerCase().includes(q)
    || f.display_path.toLowerCase().includes(q)
    || (f.content ?? '').toLowerCase().includes(q);
  const files = cli.files.filter((f) => f.home_id === homeId && !f.shared_with && match(f));
  const dirs = q ? [] : cli.dirs.filter((d) => d.home_id === homeId);
  const keys: string[] = [];
  for (const f of files) if (!keys.includes(f.group)) keys.push(f.group);
  for (const d of dirs) if (!keys.includes(d.group)) keys.push(d.group);
  const rank = (key: string) => (key === 'global' ? 0 : key.startsWith('project:') ? 1 : key.startsWith('auto:') ? 2 : 3);
  return keys
    .map((key) => {
      const groupFiles = files.filter((f) => f.group === key)
        .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || Number(b.exists) - Number(a.exists) || a.label.localeCompare(b.label));
      const groupDirs = dirs.filter((d) => d.group === key);
      const sample = groupFiles[0] ?? groupDirs[0];
      return { key, ...groupTitle(snapshot, key, sample), files: groupFiles, dirs: groupDirs };
    })
    // 실제 파일도 만들 자리도 없는 그룹(빈 auto memory 자리만 있는 프로젝트)은 뒤로 보낸다.
    .sort((a, b) => rank(a.key) - rank(b.key)
      || Number(b.files.some((f) => f.exists)) - Number(a.files.some((f) => f.exists))
      || a.title.localeCompare(b.title));
}

export function loadedBadge(file: MemoryFileInfo): { label: string; tone: 'accent' | 'muted' | 'warning' } {
  switch (file.loaded) {
    case 'always': return { label: 'every session', tone: 'accent' };
    case 'index_head': return { label: `first ${file.load_limit_lines ?? ''} lines`, tone: 'accent' };
    case 'conditional': return { label: 'when paths match', tone: 'muted' };
    default: return { label: 'on demand', tone: 'muted' };
  }
}

export function homeTitle(home: CliMemorySnapshot['homes'][number]): string {
  if (home.kind === 'operator') return 'Operator home';
  if (home.kind === 'profile') return `Profile · ${home.profile}`;
  return `Session home · ${home.credential_name || home.credential_id?.slice(0, 8) || 'credential'}`;
}

export function fileTokenCount(file: MemoryFileInfo): number {
  return file.content !== null ? estimateTokens(file.content) : Math.ceil(file.size / 4);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.round((now - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d}d ago` : `${Math.round(d / 30)}mo ago`;
}

/** 새 파일 템플릿 — Claude auto memory 는 frontmatter 를 갖춘 채로 시작한다. */
export function newFileTemplate(file: MemoryFileInfo, name: string): string {
  if (file.kind === 'auto_topic') {
    const slug = name.replace(/\.md$/i, '');
    return `---\nname: ${slug}\ndescription: \nmetadata:\n  type: project\n---\n\n`;
  }
  if (file.format === 'section_entries') return '';
  if (file.kind === 'instructions') return '';
  return `# ${name.replace(/\.md$/i, '')}\n\n`;
}
