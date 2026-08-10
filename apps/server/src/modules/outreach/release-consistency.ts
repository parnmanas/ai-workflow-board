/**
 * Pure release-consistency analysis (ticket 31e7cd24 범위 3 — "릴리스 변경사항
 * 정합성 점검"). Dependency-free (no DB, no HTTP) so it is trivially
 * unit-testable — mirrors deployment-options.ts's "kept dependency-free"
 * reasoning. release-consistency.service.ts is the only caller: it gathers
 * `changedFiles` (github-connector.service.ts's compareCommits),
 * `openIssues` (listOpenIssuesSince), and `doneTickets` (this release
 * window's Done tickets), then hands them here.
 *
 * Heuristic, not authoritative — keyword/filename matching produces
 * candidates for a human to confirm, never an autonomous action (the
 * ticket's explicit "문서 자동 수정은 이 티켓 범위 밖" and the broader risk note
 * about false-positive resolution claims apply here too).
 */

export interface ReleaseConsistencyIssue {
  number: number;
  title: string;
  body: string;
  html_url: string;
}

export interface ReleaseConsistencyDoneTicket {
  id: string;
  title: string;
}

export interface ReleaseConsistencyInput {
  changedFiles: string[];
  openIssues: ReleaseConsistencyIssue[];
  doneTickets: ReleaseConsistencyDoneTicket[];
}

export interface CandidateResolvedIssue {
  number: number;
  title: string;
  html_url: string;
  matchedOn: string;
}

export interface ReleaseConsistencyReport {
  candidateResolvedIssues: CandidateResolvedIssue[];
  undocumentedChanges: boolean;
  changelogGap: boolean;
  summary: string;
}

const DOC_FILE_PATTERN = /(^|\/)(readme|changelog)(\.[a-z0-9]+)?$/i;
const CHANGELOG_FILE_PATTERN = /(^|\/)changelog(\.[a-z0-9]+)?$/i;
const TEST_FILE_PATTERN = /(^|\/)(test|tests|__tests__|spec)\//i;
const MAX_CANDIDATES = 10; // bound — keyword matching can over-match on common words
const MIN_WORD_LEN = 3;

function extractWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length >= MIN_WORD_LEN);
}

export function analyzeReleaseConsistency(input: ReleaseConsistencyInput): ReleaseConsistencyReport {
  const docTouched = input.changedFiles.some((f) => DOC_FILE_PATTERN.test(f));
  const changelogTouched = input.changedFiles.some((f) => CHANGELOG_FILE_PATTERN.test(f));
  const codeChanged = input.changedFiles.filter((f) => !DOC_FILE_PATTERN.test(f) && !TEST_FILE_PATTERN.test(f));

  const undocumentedChanges = codeChanged.length > 0 && !docTouched;
  const changelogGap = input.doneTickets.length > 0 && !changelogTouched;

  const changedWords = new Set<string>();
  for (const f of input.changedFiles) for (const w of extractWords(f)) changedWords.add(w);
  for (const t of input.doneTickets) for (const w of extractWords(t.title)) changedWords.add(w);

  const candidateResolvedIssues: CandidateResolvedIssue[] = [];
  for (const issue of input.openIssues) {
    const text = `${issue.title} ${issue.body}`.toLowerCase();
    const matched = [...changedWords].find((w) => text.includes(w));
    if (matched) candidateResolvedIssues.push({ number: issue.number, title: issue.title, html_url: issue.html_url, matchedOn: matched });
    if (candidateResolvedIssues.length >= MAX_CANDIDATES) break;
  }

  const lines: string[] = ['## 릴리스 변경사항 정합성 점검'];
  if (candidateResolvedIssues.length > 0) {
    lines.push('', '**이번 변경으로 해결됐을 가능성이 있는 열린 이슈:**');
    for (const c of candidateResolvedIssues) lines.push(`- #${c.number} ${c.title} (${c.html_url}) — 일치어: "${c.matchedOn}"`);
  }
  if (undocumentedChanges) {
    lines.push('', `**문서 미갱신 후보**: 코드 변경 ${codeChanged.length}개 파일이 있었지만 README/CHANGELOG가 갱신되지 않았습니다.`);
  }
  if (changelogGap) {
    lines.push('', `**CHANGELOG 누락 후보**: 이번 릴리스에 사용자 가시 티켓 ${input.doneTickets.length}건이 포함됐지만 CHANGELOG가 갱신되지 않았습니다.`);
  }
  if (candidateResolvedIssues.length === 0 && !undocumentedChanges && !changelogGap) {
    lines.push('', '특이사항 없음 — 휴리스틱 매칭 기준으로 후보 이슈/문서 갭이 발견되지 않았습니다.');
  }
  lines.push('', '_이 리포트는 파일명/제목 키워드 매칭 기반 휴리스틱입니다 — 사람 확인을 대체하지 않습니다._');

  return { candidateResolvedIssues, undocumentedChanges, changelogGap, summary: lines.join('\n') };
}
