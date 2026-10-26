import { getLocaleTag } from '../../i18n/core';
import { t as translate } from '../../i18n/core';
/**
 * CLI 메모리 분석 — 순수 함수(docs/cli-memory.md "분석").
 *
 * 매니저가 준 스냅샷(파일 목록 + 내용 + 경로 확인 결과) 위에서 "이 메모리가 에이전트에게 실제로
 * 어떻게 작동하는가" 를 본다. 지적 하나하나는 실제로 무엇이 일어나는지를 말한다 — 예: Codex 는
 * `project_doc_max_bytes` 를 넘는 AGENTS.md 뒷부분을 버리고, Claude 는 auto memory 색인의 200줄 뒤를
 * 읽지 않고, Hermes 는 상한을 넘으면 새 메모를 거부한다. 고칠 수 있는 것에는 `fix` 를 붙여 화면이
 * 한 번에 고친다.
 */

import type { CliMemorySnapshot, MemoryFileInfo, MemoryHostSnapshot } from '../../types';
import {
  AUTO_MEMORY_TYPES,
  basenameOf,
  dirnameOf,
  entriesCharCount,
  entriesRoundTrip,
  estimateTokens,
  memoryType,
  parseEntries,
  parseFrontmatter,
  parseIndexLinks,
  wikiLinks,
} from './memoryFormat.logic';

export type FindingSeverity = 'critical' | 'warning' | 'info';

export type FindingCategory =
  | 'secret'
  | 'budget'
  | 'truncation'
  | 'limit'
  | 'format'
  | 'index'
  | 'frontmatter'
  | 'link'
  | 'duplicate'
  | 'stale_path'
  | 'relative_date'
  | 'empty'
  | 'session_home'
  | 'sync'
  | 'override'
  | 'staleness';

/** 화면이 한 번에 고칠 수 있는 동작. 실제 새 내용은 화면이 그 순간의 내용으로 다시 계산한다. */
export type MemoryFix =
  | { kind: 'rebuild_index'; cli: string; path: string }
  | { kind: 'link_home'; cli: string; path: string; target: string }
  | { kind: 'dedupe_lines'; cli: string; path: string }
  | { kind: 'normalize_entries'; cli: string; path: string }
  | { kind: 'delete_empty'; cli: string; path: string }
  | { kind: 'apply'; cli: string; path: string; target_cli: string; target_path: string };

export interface MemoryFinding {
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  cli: string;
  title: string;
  detail: string;
  /** 관련 파일 경로(첫 번째가 주 대상). */
  paths: string[];
  fix?: MemoryFix;
  /** 같은 파일을 함께 읽는 다른 CLI — 프로젝트 AGENTS.md 처럼 여러 CLI 가 공유하는 파일의 내용 지적은 한 번만 낸다. */
  also_clis?: string[];
}

export interface LoadBudget {
  /** project 범위면 그 폴더, 전역만이면 null. */
  project_dir: string | null;
  tokens: number;
  bytes: number;
  files: Array<{ path: string; label: string; tokens: number }>;
}

export interface CliMemoryStats {
  cli: string;
  label: string;
  files: number;
  existing: number;
  bytes: number;
  /** 매 세션이 내는 비용 — 프로젝트별(전역 + 그 프로젝트) 중 가장 큰 것. */
  worst_budget: LoadBudget;
  budgets: LoadBudget[];
  on_demand_tokens: number;
  score: number;
  counts: Record<FindingSeverity, number>;
}

export interface MemoryAnalysis {
  findings: MemoryFinding[];
  stats: CliMemoryStats[];
  score: number;
}

/** 매 세션에 들어가는 토큰이 이만큼 넘으면 경고 / 심각. */
export const BUDGET_WARN_TOKENS = 8_000;
export const BUDGET_CRITICAL_TOKENS = 20_000;
/** 이만큼 손대지 않은 auto memory 주제 파일은 다시 볼 만하다. */
export const STALE_DAYS = 120;

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { get name() { return translate('Anthropic API key'); }, re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { get name() { return translate('OpenAI API key'); }, re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { get name() { return translate('GitHub token'); }, re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { get name() { return translate('AWS access key'); }, re: /\bAKIA[0-9A-Z]{16}\b/ },
  { get name() { return translate('Slack token'); }, re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { get name() { return translate('Google API key'); }, re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { get name() { return translate('private key'); }, re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'password', re: /\b(?:password|passwd|pwd|비밀번호)\s*[:=]\s*["']?[^\s"'`]{6,}/i },
  { get name() { return translate('bearer token'); }, re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/ },
];

const RELATIVE_DATE_RE = /\b(?:yesterday|today|tomorrow|last (?:week|month|night)|next (?:week|month)|this (?:week|month)|recently)\b|어제|오늘|내일|그제|지난주|지난 주|이번 주|다음 주|지난달|최근에/i;

/** 이 파일이 지금 세션에 들어가는 내용(색인은 앞 N줄). */
export function loadedText(file: MemoryFileInfo): string {
  const text = file.content ?? '';
  if (file.loaded === 'index_head' && file.load_limit_lines) {
    return text.split(/\r?\n/).slice(0, file.load_limit_lines).join('\n');
  }
  return text;
}

function fileTokens(file: MemoryFileInfo): number {
  if (file.content !== null) return estimateTokens(loadedText(file));
  // 내용이 생략됐으면 크기로 어림한다.
  return Math.ceil(file.size / 4);
}

/** 그 CLI 의 실제 파일(다른 홈과 공유된 사본·없는 자리 제외). */
export function realFiles(cli: CliMemorySnapshot): MemoryFileInfo[] {
  return cli.files.filter((f) => f.exists && !f.shared_with);
}

function operatorFiles(cli: CliMemorySnapshot): MemoryFileInfo[] {
  return realFiles(cli).filter((f) => f.home_id === 'operator');
}

/** 매 세션 비용 — 전역(always) + 각 프로젝트의 always/색인. 운영자 홈 기준. */
export function loadBudgets(cli: CliMemorySnapshot): LoadBudget[] {
  const files = operatorFiles(cli).filter((f) => f.loaded === 'always' || f.loaded === 'index_head');
  const global = files.filter((f) => f.scope === 'global');
  const projects = Array.from(new Set(files.filter((f) => f.project_dir).map((f) => f.project_dir as string)));
  const build = (projectDir: string | null, list: MemoryFileInfo[]): LoadBudget => {
    const entries = list.map((f) => ({ path: f.path, label: f.label, tokens: fileTokens(f) }));
    return {
      project_dir: projectDir,
      tokens: entries.reduce((sum, e) => sum + e.tokens, 0),
      bytes: list.reduce((sum, f) => sum + f.size, 0),
      files: entries.sort((a, b) => b.tokens - a.tokens),
    };
  };
  const out = [build(null, global)];
  for (const dir of projects) out.push(build(dir, [...global, ...files.filter((f) => f.project_dir === dir)]));
  return out;
}

/** 비교 단위 — 빈 줄로 나눈 문단에서 제목 줄과 주석을 뺀 것(60자 이상만). */
function paragraphs(text: string): string[] {
  return parseFrontmatter(text).body
    .split(/\n\s*\n/)
    .map((p) => p.split(/\r?\n/).filter((l) => !/^\s*#{1,6}\s/.test(l) && !/^\s*<!--.*-->\s*$/.test(l)).join('\n').trim())
    .filter((p) => p.length >= 60);
}

function shingles(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i += 1) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  if (words.length < 3 && words.length) out.add(words.join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 한 파일 안에서 두 번 이상 나오는 실질적인 줄(20자 이상, 구분선·코드 울타리 제외). */
export function duplicateLines(text: string): string[] {
  const counts = new Map<string, number>();
  let fence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const line = raw.trim();
    if (line.length < 20 || /^[-*_=#|:\s]+$/.test(line) || line === '§') continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return Array.from(counts.entries()).filter(([, n]) => n > 1).map(([line]) => line);
}

/** 같은 줄이 두 번째로 나오는 곳부터 지운다(코드 울타리 안은 건드리지 않는다). */
export function dedupeLines(text: string): string {
  const dups = new Set(duplicateLines(text));
  const seen = new Set<string>();
  let fence = false;
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) fence = !fence;
    const line = raw.trim();
    if (!fence && dups.has(line)) {
      if (seen.has(line)) continue;
      seen.add(line);
    }
    out.push(raw);
  }
  return out.join('\n');
}

function mask(secret: string): string {
  const s = secret.trim();
  return s.length <= 8 ? '••••' : `${s.slice(0, 4)}…${s.slice(-2)}`;
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : null;
}

function homeLabel(cli: CliMemorySnapshot, homeId: string): string {
  const home = cli.homes.find((h) => h.id === homeId);
  if (!home) return homeId;
  if (home.kind === 'session') return translate('AWB session home ({0})', { 0: home.credential_name || home.credential_id?.slice(0, 8) || 'credential' });
  if (home.kind === 'profile') return `profile ${home.profile}`;
  return translate('operator home');
}

/** 전역 지침 파일(사람이 쓰는 것) — CLI 간 비교·세션 홈 비교의 단위. */
function globalInstructionFiles(cli: CliMemorySnapshot, homeId = 'operator'): MemoryFileInfo[] {
  return cli.files.filter((f) => f.home_id === homeId && f.scope === 'global' && f.kind === 'instructions');
}

function analyzeCli(cli: CliMemorySnapshot, now: number): MemoryFinding[] {
  const out: MemoryFinding[] = [];
  const add = (f: Omit<MemoryFinding, 'cli'>) => out.push({ ...f, cli: cli.cli });
  const files = realFiles(cli);

  for (const file of files) {
    const text = file.content ?? '';
    // 비밀 — 모든 세션 프롬프트로 새어 나간다.
    for (const p of SECRET_PATTERNS) {
      const m = p.re.exec(text);
      if (!m) continue;
      add({
        id: `secret:${file.path}:${p.name}`,
        severity: 'critical',
        category: 'secret',
        title: translate('Possible {0} in {1}', { 0: p.name, 1: file.label }),
        detail: translate('Found "{0}". Memory is pasted into agent prompts{1}; keep secrets in AWB credentials instead.', { 0: mask(m[0]), 1: file.loaded === 'always' ? translate(' on every session') : '' }),
        paths: [file.path],
      });
      break;
    }
    if (!text.trim() && file.content !== null) {
      add({
        id: `empty:${file.path}`, severity: 'info', category: 'empty',
        title: translate('{0} is empty', { 0: file.label }), detail: translate('{0} exists but holds nothing.', { 0: file.display_path }), paths: [file.path],
        ...(file.editable ? { fix: { kind: 'delete_empty' as const, cli: cli.cli, path: file.path } } : {}),
      });
      continue;
    }
    // 같은 줄 반복.
    if (file.format === 'markdown' && file.kind !== 'generated') {
      const dups = duplicateLines(text);
      if (dups.length) {
        add({
          id: `dupline:${file.path}`, severity: 'warning', category: 'duplicate',
          title: translate('{0} repeated line(s) in {1}', { 0: dups.length, 1: file.label }),
          detail: translate('e.g. "{0}{1}" — every repeat costs tokens{2}.', { 0: dups[0].slice(0, 90), 1: dups[0].length > 90 ? '…' : '', 2: file.loaded === 'always' ? translate(' on every session') : '' }),
          paths: [file.path],
          ...(file.editable ? { fix: { kind: 'dedupe_lines' as const, cli: cli.cli, path: file.path } } : {}),
        });
      }
    }
    // 이 장비에 없는 경로.
    if (file.missing_paths?.length) {
      const shown = file.missing_paths.slice(0, 4).join(', ');
      add({
        id: `stale:${file.path}`, severity: 'info', category: 'stale_path',
        title: translate('{0} referenced path(s) not found on this host', { 0: file.missing_paths.length }),
        detail: translate('{0}: {1}{2}. Renamed or deleted paths mislead the agent — unless they refer to another machine or are examples.', { 0: file.label, 1: shown, 2: file.missing_paths.length > 4 ? ' …' : '' }),
        paths: [file.path],
      });
    }
    // 상대 날짜(auto memory · Hermes 항목) — 나중에 읽으면 뜻이 바뀐다.
    if ((file.kind === 'auto_topic' || file.kind === 'entries' || file.kind === 'auto_index') && RELATIVE_DATE_RE.test(text)) {
      const m = RELATIVE_DATE_RE.exec(text);
      add({
        id: `reldate:${file.path}`, severity: 'info', category: 'relative_date',
        title: translate('Relative date in {0}', { 0: file.label }),
        detail: translate('"{0}" — memory is read weeks later; write absolute dates (e.g. 2026-10-21).', { 0: m?.[0] }),
        paths: [file.path],
      });
    }
    // 오래된 auto memory.
    if (file.kind === 'auto_topic') {
      const days = daysSince(file.mtime, now);
      if (days !== null && days >= STALE_DAYS) {
        add({
          id: `old:${file.path}`, severity: 'info', category: 'staleness',
          title: translate('{0} untouched for {1} days', { 0: file.label, 1: days }),
          detail: translate('Facts in auto memory decay — confirm it still holds or delete it.'),
          paths: [file.path],
        });
      }
    }
  }

  // Claude auto memory 색인 · frontmatter · 링크.
  const autoGroups = new Map<string, MemoryFileInfo[]>();
  for (const f of cli.files.filter((f) => (f.kind === 'auto_index' || f.kind === 'auto_topic') && !f.shared_with)) {
    const list = autoGroups.get(f.group) ?? [];
    list.push(f);
    autoGroups.set(f.group, list);
  }
  for (const list of autoGroups.values()) {
    const index = list.find((f) => f.kind === 'auto_index');
    const topics = list.filter((f) => f.kind === 'auto_topic' && f.exists);
    if (!index) continue;
    const topicNames = new Set(topics.map((t) => basenameOf(t.path)));
    if (index.exists && index.content !== null) {
      const lines = index.content.split(/\r?\n/).length;
      if (index.load_limit_lines && lines > index.load_limit_lines) {
        add({
          id: `indexcap:${index.path}`, severity: 'warning', category: 'truncation',
          title: translate('Auto memory index is {0} lines — only {1} are loaded', { 0: lines, 1: index.load_limit_lines }),
          detail: translate('Claude reads the first {0} lines of {1}; everything after is invisible at session start. Shorten entries or move detail into topic files.', { 0: index.load_limit_lines, 1: index.display_path }),
          paths: [index.path],
        });
      }
      const links = parseIndexLinks(index.content);
      const dangling = links.filter((l) => !topicNames.has(l.file));
      const linked = new Set(links.map((l) => l.file));
      const orphans = topics.filter((t) => !linked.has(basenameOf(t.path)));
      if (dangling.length || orphans.length) {
        const parts: string[] = [];
        if (dangling.length) parts.push(translate('{0} link(s) to missing files ({1})', { 0: dangling.length, 1: dangling.slice(0, 3).map((d) => d.file).join(', ') }));
        if (orphans.length) parts.push(translate('{0} topic file(s) not in the index ({1}) — Claude never learns they exist', { 0: orphans.length, 1: orphans.slice(0, 3).map((o) => basenameOf(o.path)).join(', ') }));
        add({
          id: `index:${index.path}`, severity: 'warning', category: 'index',
          title: translate('Auto memory index is out of sync'),
          detail: `${parts.join('; ')}.`,
          paths: [index.path, ...orphans.map((o) => o.path)],
          ...(index.editable ? { fix: { kind: 'rebuild_index' as const, cli: cli.cli, path: index.path } } : {}),
        });
      }
    } else if (topics.length) {
      add({
        id: `index:${index.path}`, severity: 'warning', category: 'index',
        title: translate('Auto memory has topic files but no index'),
        detail: translate('{0} topic file(s) in {1} are never loaded because MEMORY.md is missing.', { 0: topics.length, 1: dirnameOf(index.display_path) }),
        paths: [index.path],
        fix: { kind: 'rebuild_index', cli: cli.cli, path: index.path },
      });
    }
    // frontmatter + [[링크]].
    const names = new Set<string>();
    for (const t of topics) {
      const fm = parseFrontmatter(t.content ?? '');
      if (fm.fields.name) names.add(fm.fields.name);
    }
    for (const t of topics) {
      if (t.content === null) continue;
      const fm = parseFrontmatter(t.content);
      const problems: string[] = [];
      if (!fm.present) problems.push(translate('no frontmatter'));
      else {
        if (!fm.fields.name) problems.push(translate('no name'));
        if (!fm.fields.description) problems.push(translate('no description'));
        const type = memoryType(fm);
        if (!type) problems.push(translate('no type'));
        else if (!(AUTO_MEMORY_TYPES as readonly string[]).includes(type)) problems.push(translate('unknown type "{0}"', { 0: type }));
      }
      if (problems.length) {
        add({
          id: `fm:${t.path}`, severity: 'info', category: 'frontmatter',
          title: `${t.label}: ${problems.join(', ')}`,
          detail: translate('name / description / type let the agent judge relevance without opening the file.'),
          paths: [t.path],
        });
      }
      const broken = wikiLinks(t.content).filter((name) => !names.has(name));
      if (broken.length) {
        add({
          id: `wiki:${t.path}`, severity: 'info', category: 'link',
          title: translate('{0} links to {1} unwritten memory', { 0: t.label, 1: broken.length }),
          detail: translate('[[{0}]]{1} — fine as a to-do, otherwise fix the name.', { 0: broken.slice(0, 3).join(']], [['), 1: broken.length > 3 ? ' …' : '' }),
          paths: [t.path],
        });
      }
    }
  }

  // Hermes 항목 파일 — 상한 · drift.
  for (const file of files.filter((f) => f.format === 'section_entries' && f.content !== null)) {
    const text = file.content ?? '';
    if (!entriesRoundTrip(text)) {
      add({
        id: `drift:${file.path}`, severity: 'critical', category: 'format',
        title: translate('{0} is not a clean §-separated list', { 0: file.label }),
        detail: translate('Hermes refuses to write a memory file that does not round-trip through its parser (drift guard) — new memories are silently not saved until it is normalized.'),
        paths: [file.path],
        ...(file.editable ? { fix: { kind: 'normalize_entries' as const, cli: cli.cli, path: file.path } } : {}),
      });
    }
    if (file.char_limit) {
      const entries = parseEntries(text);
      const used = entriesCharCount(entries);
      const longest = entries.reduce((m, e) => Math.max(m, [...e].length), 0);
      if (used > file.char_limit || longest > file.char_limit) {
        add({
          id: `limit:${file.path}`, severity: 'critical', category: 'limit',
          title: translate('{0} is over its {1}-character cap ({2})', { 0: file.label, 1: file.char_limit, 2: used }),
          detail: translate('Hermes rejects new entries while the store is over its cap. Merge or trim entries.'),
          paths: [file.path],
        });
      } else if (used >= file.char_limit * 0.9) {
        add({
          id: `limit:${file.path}`, severity: 'warning', category: 'limit',
          title: translate('{0} is {1}% full ({2}/{3})', { 0: file.label, 1: Math.round((used / file.char_limit) * 100), 2: used, 3: file.char_limit }),
          detail: translate('Hermes will start refusing new memories soon. Consolidate overlapping entries.'),
          paths: [file.path],
        });
      }
    }
  }

  // Codex: 프로젝트 문서 상한 · override.
  const docMax = typeof cli.settings.project_doc_max_bytes === 'number' ? cli.settings.project_doc_max_bytes : null;
  if (docMax) {
    const byProject = new Map<string, MemoryFileInfo[]>();
    for (const f of files.filter((f) => f.scope === 'project' && f.kind === 'instructions' && f.loaded === 'always' && f.project_dir)) {
      const list = byProject.get(f.project_dir as string) ?? [];
      list.push(f);
      byProject.set(f.project_dir as string, list);
    }
    for (const [dir, list] of byProject) {
      const bytes = list.reduce((s, f) => s + f.size, 0);
      if (bytes > docMax) {
        add({
          id: `doccap:${cli.cli}:${dir}`, severity: 'critical', category: 'truncation',
          title: translate('{0} drops {1} KiB of project instructions', { 0: cli.label, 1: ((bytes - docMax) / 1024).toFixed(1) }),
          detail: translate('{0} is {1} KiB but project_doc_max_bytes is {2} KiB — the rest is silently cut. Trim it or raise project_doc_max_bytes in config.toml.', { 0: list.map((f) => f.display_path).join(' + '), 1: (bytes / 1024).toFixed(1), 2: (docMax / 1024).toFixed(0) }),
          paths: list.map((f) => f.path),
        });
      }
    }
  }
  for (const f of files.filter((f) => /AGENTS\.override\.md$/.test(f.path))) {
    add({
      id: `override:${f.path}`, severity: 'info', category: 'override',
      title: translate('{0} replaces AGENTS.md', { 0: f.label }),
      detail: translate('While {0} exists, the AGENTS.md next to it is ignored.', { 0: f.display_path }),
      paths: [f.path],
    });
  }

  // 매 세션 비용.
  const budgets = loadBudgets(cli);
  const worst = budgets.reduce((a, b) => (b.tokens > a.tokens ? b : a), budgets[0]);
  if (worst && worst.tokens >= BUDGET_WARN_TOKENS) {
    const top = worst.files.slice(0, 3).map((f) => `${f.label} ≈${f.tokens.toLocaleString(getLocaleTag())}`).join(', ');
    add({
      id: `budget:${cli.cli}`, severity: worst.tokens >= BUDGET_CRITICAL_TOKENS ? 'critical' : 'warning', category: 'budget',
      title: translate('≈{0} tokens of memory load into every {1} session', { 0: worst.tokens.toLocaleString(getLocaleTag()), 1: cli.label }),
      detail: translate('Largest: {0}. Always-loaded memory costs context and attention on every turn — move reference detail into on-demand files.', { 0: top }),
      paths: worst.files.map((f) => f.path),
    });
  }

  // 중복 문단(같은 CLI 안, 다른 파일끼리).
  const paras: Array<{ file: MemoryFileInfo; text: string; sh: Set<string> }> = [];
  for (const f of files.filter((f) => f.format === 'markdown' && f.kind !== 'generated' && f.kind !== 'knowledge' && f.content)) {
    for (const p of paragraphs(f.content ?? '')) paras.push({ file: f, text: p, sh: shingles(p) });
    if (paras.length > 800) break;
  }
  const reported = new Set<string>();
  for (let i = 0; i < paras.length; i += 1) {
    for (let j = i + 1; j < paras.length; j += 1) {
      if (paras[i].file.path === paras[j].file.path) continue;
      const key = [paras[i].file.path, paras[j].file.path].sort().join('|');
      if (reported.has(key)) continue;
      if (jaccard(paras[i].sh, paras[j].sh) >= 0.8) {
        reported.add(key);
        add({
          id: `dup:${key}`, severity: 'warning', category: 'duplicate',
          title: translate('Same note in {0} and {1}', { 0: paras[i].file.label, 1: paras[j].file.label }),
          detail: translate('"{0}…" — duplicates drift apart; keep one.', { 0: paras[i].text.slice(0, 100).replace(/\s+/g, ' ') }),
          paths: [paras[i].file.path, paras[j].file.path],
        });
      }
    }
  }

  // 세션 홈 — AWB 세션(credential 별 홈)이 운영자의 전역 지침을 보는가.
  const operatorGlobals = globalInstructionFiles(cli).filter((f) => f.exists);
  for (const home of cli.homes.filter((h) => h.kind === 'session')) {
    for (const source of operatorGlobals) {
      const name = basenameOf(source.path);
      const slot = cli.files.find((f) => f.home_id === home.id && f.scope === 'global' && basenameOf(f.path) === name);
      if (!slot) continue;
      if (!slot.exists) {
        add({
          id: `home:${slot.path}`, severity: 'warning', category: 'session_home',
          title: translate('AWB sessions on {0} don\'t see your {1}', { 0: home.credential_name || translate('a credential'), 1: name }),
          detail: translate('Sessions bound to this credential use {0} as their {1} home, which has no {2} — your global instructions ({3}) never load there. Link it so both stay in sync.', { 0: home.display_path, 1: cli.label, 2: name, 3: source.display_path }),
          paths: [slot.path, source.path],
          fix: { kind: 'link_home', cli: cli.cli, path: slot.path, target: source.path },
        });
      } else if (!slot.link_target && slot.hash && source.hash && slot.hash !== source.hash) {
        add({
          id: `homediff:${slot.path}`, severity: 'info', category: 'session_home',
          title: translate('{0} has its own {1}', { 0: homeLabel(cli, home.id), 1: name }),
          detail: translate('It differs from {0}. Intentional per-credential instructions are fine; otherwise link it to the operator copy.', { 0: source.display_path }),
          paths: [slot.path, source.path],
        });
      }
    }
  }
  return out;
}

/**
 * CLI 사이 — 다른 CLI 의 전역 지침에만 있는 문단. 같은 장비에서 여러 CLI 를 쓰면 한쪽에만 적은 규칙은
 * 다른 쪽 세션이 모른다. 대상 CLI 마다 가장 많이 빠진 출처 하나만 낸다(조합마다 내면 시끄럽다).
 */
function analyzeAcrossClis(clis: CliMemorySnapshot[]): MemoryFinding[] {
  const out: MemoryFinding[] = [];
  const sources = clis
    .filter((c) => c.detected)
    .map((c) => ({ cli: c, file: globalInstructionFiles(c).find((f) => f.exists && f.loaded === 'always' && f.content) }))
    .filter((x): x is { cli: CliMemorySnapshot; file: MemoryFileInfo } => !!x.file)
    .map((x) => ({ ...x, paras: paragraphs(x.file.content ?? '').map((p) => shingles(p)) }))
    .filter((x) => x.paras.length > 0);
  for (const other of clis.filter((c) => c.detected)) {
    const target = globalInstructionFiles(other).find((f) => f.loaded === 'always' || !f.exists);
    if (!target || !target.editable) continue;
    const theirs = paragraphs(target.content ?? '').map((p) => shingles(p));
    let best: { src: (typeof sources)[number]; missing: number } | null = null;
    for (const src of sources) {
      if (src.cli.cli === other.cli) continue;
      const missing = src.paras.filter((p) => !theirs.some((t) => jaccard(p, t) >= 0.6)).length;
      if (missing && (!best || missing > best.missing)) best = { src, missing };
    }
    if (!best) continue;
    out.push({
      id: `sync:${best.src.cli.cli}:${other.cli}`,
      severity: 'info',
      category: 'sync',
      cli: other.cli,
      title: translate('{0} note(s) from {1} are missing in {2}', { 0: best.missing, 1: best.src.cli.label, 2: other.label }),
      detail: translate('{0} has guidance that {1} lacks. If both CLIs work here, apply it as a managed block — re-applying later updates only that block.', { 0: best.src.file.display_path, 1: target.display_path }),
      paths: [target.path, best.src.file.path],
      fix: { kind: 'apply', cli: best.src.cli.cli, path: best.src.file.path, target_cli: other.cli, target_path: target.path },
    });
  }
  return out;
}

/** 파일 내용에 대한 지적 — 같은 파일이면 어느 CLI 에서 봐도 같은 말이다. */
const CONTENT_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  'secret', 'stale_path', 'relative_date', 'empty', 'frontmatter', 'link', 'staleness', 'format', 'override',
]);

/** 이 지적이 그 CLI 에 해당하는가(공유 파일로 다른 CLI 아래 묶인 것 포함). */
export function findingAppliesTo(finding: MemoryFinding, cli: string): boolean {
  return finding.cli === cli || !!finding.also_clis?.includes(cli);
}

const WEIGHT: Record<FindingSeverity, number> = { critical: 15, warning: 5, info: 1 };
const ORDER: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function scoreOf(findings: readonly MemoryFinding[]): number {
  const penalty = findings.reduce((s, f) => s + WEIGHT[f.severity], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

export function analyzeSnapshot(snapshot: MemoryHostSnapshot, now = Date.now()): MemoryAnalysis {
  const findings: MemoryFinding[] = [];
  const stats: CliMemoryStats[] = [];
  const shared = new Map<string, MemoryFinding>();
  for (const cli of snapshot.clis.filter((c) => c.detected)) {
    const own = analyzeCli(cli, now);
    for (const f of own) {
      const key = CONTENT_CATEGORIES.has(f.category) || (f.category === 'duplicate' && f.paths.length === 1) ? `${f.category}:${f.paths[0]}` : '';
      const first = key ? shared.get(key) : undefined;
      if (first) {
        first.also_clis = [...(first.also_clis ?? []), cli.cli];
        continue;
      }
      if (key) shared.set(key, f);
      findings.push(f);
    }
    const budgets = loadBudgets(cli);
    const real = realFiles(cli);
    const counts = { critical: 0, warning: 0, info: 0 } as Record<FindingSeverity, number>;
    for (const f of own) counts[f.severity] += 1;
    stats.push({
      cli: cli.cli,
      label: cli.label,
      files: cli.files.length,
      existing: real.length,
      bytes: real.reduce((s, f) => s + f.size, 0),
      worst_budget: budgets.reduce((a, b) => (b.tokens > a.tokens ? b : a), budgets[0]),
      budgets,
      on_demand_tokens: real.filter((f) => f.loaded === 'on_demand' || f.loaded === 'conditional').reduce((s, f) => s + fileTokens(f), 0),
      score: scoreOf(own),
      counts,
    });
  }
  const across = analyzeAcrossClis(snapshot.clis);
  findings.push(...across);
  for (const f of across) {
    const s = stats.find((x) => x.cli === f.cli);
    if (s) s.counts[f.severity] += 1;
  }
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.cli.localeCompare(b.cli) || a.title.localeCompare(b.title));
  const score = stats.length ? Math.round(stats.reduce((s, x) => s + x.score, 0) / stats.length) : 100;
  return { findings, stats, score };
}

/**
 * "에이전트로 최적화" 프롬프트 — 그 CLI 의 세션에 보낼 지시문. 분석 결과를 근거로 주고, 형식 규칙과
 * 지켜야 할 것(사실을 잃지 말 것, 비밀을 지울 것)을 명시한다.
 */
export function optimizationPrompt(cli: CliMemorySnapshot, findings: readonly MemoryFinding[], opts: { projectDir?: string | null } = {}): string {
  const files = realFiles(cli)
    .filter((f) => f.home_id === 'operator' && f.kind !== 'generated' && f.kind !== 'knowledge')
    .filter((f) => !opts.projectDir || f.scope === 'global' || f.project_dir === opts.projectDir);
  const lines: string[] = [];
  lines.push(`[AWB Memory optimization] Review and improve the ${cli.label} memory on this machine.`);
  lines.push('');
  lines.push('Goal: memory that is short, correct, non-duplicated and well organized, without losing any durable fact. Loaded files cost context on every session.');
  lines.push('');
  lines.push('Files:');
  for (const f of files.slice(0, 80)) {
    lines.push(`- ${f.path} — ${f.label}; ${f.loaded === 'always' ? 'loaded every session' : f.loaded === 'index_head' ? `first ${f.load_limit_lines} lines loaded every session` : 'read on demand'}; ≈${fileTokens(f)} tokens`);
  }
  const relevant = findings.filter((f) => f.cli === cli.cli && (!opts.projectDir || f.paths.some((p) => files.some((x) => x.path === p))));
  if (relevant.length) {
    lines.push('');
    lines.push('Findings from AWB\'s analysis:');
    for (const f of relevant.slice(0, 40)) lines.push(`- [${f.severity}] ${f.title} — ${f.detail}`);
  }
  lines.push('');
  lines.push('Rules:');
  lines.push('1. Read every file before changing it. Keep each durable fact exactly once; merge duplicates.');
  lines.push('2. Delete a statement only after verifying it is wrong or stale (e.g. a path that no longer exists). When unsure, keep it and tell me.');
  lines.push('3. Keep always-loaded files lean; move reference detail into on-demand files.');
  if (cli.files.some((f) => f.kind === 'auto_index')) {
    lines.push('4. Claude auto memory: one fact per topic file with name/description/metadata.type frontmatter; MEMORY.md is a one-line-per-file index under 200 lines.');
  }
  if (cli.files.some((f) => f.format === 'section_entries')) {
    lines.push('4. Hermes MEMORY.md/USER.md: entries separated by a line containing only "§"; stay under each file\'s character cap.');
  }
  lines.push('5. Convert relative dates to absolute dates. Remove any secret you find and tell me where it was.');
  lines.push('6. Finish with a short per-file summary of what changed.');
  return lines.join('\n');
}
