import type { ClonePolicy } from '../types';

// Repo clone 정책 폼 로직 (ticket bddb63ee).
//
// 이 저장소에는 jsdom 이 없어서, 컴포넌트의 load-bearing 로직은 React 밖으로 빼
// 단위 테스트한다(environmentConfig.logic.ts 와 같은 관례 — 루트 CLAUDE.md 참고).
// 여기 있는 함수들이 곧 ClonePolicyEditor 가 실제로 import 해서 쓰는 구현이며,
// 테스트도 이 모듈을 그대로 검증한다(로직 복제본이 아니다).
//
// 같은 ClonePolicy 형태를 두 표면이 편집한다 — Resource 설정(repo별 override)과
// Workspace Settings(워크스페이스 기본값). 저장 대상만 다르므로 필드 매핑과 입력
// 검증은 이 한 곳에 둔다.
//
// 서버 zod 가 최종 검증 권한이며, 여기서는 사용자가 **어느 칸이 잘못됐는지** 알 수
// 있도록 같은 범위를 미리 확인할 뿐이다. 빈 칸은 "미지정"이라 저장 payload 에서 키
// 자체가 빠지고, 그러면 Repo Resource → Workspace → 시스템 기본값 순으로 흘러내린다
// (그래서 0 과 미지정을 구분해야 하고, 폼 상태를 문자열로 들고 있다).

export interface ClonePolicyFormState {
  timeout: string;
  idleTimeout: string;
  depth: string;
  filter: string;
  singleBranch: boolean;
}

export const EMPTY_CLONE_POLICY_FORM: ClonePolicyFormState = {
  timeout: '',
  idleTimeout: '',
  depth: '',
  filter: '',
  singleBranch: false,
};

/** 서버가 돌려준 정책(파싱된 객체) → 폼 상태. null/미지정은 빈 칸이 된다. */
export function clonePolicyToForm(policy: ClonePolicy | null | undefined): ClonePolicyFormState {
  return {
    timeout: policy?.clone_timeout_seconds != null ? String(policy.clone_timeout_seconds) : '',
    idleTimeout: policy?.clone_idle_timeout_seconds != null ? String(policy.clone_idle_timeout_seconds) : '',
    depth: policy?.clone_depth != null ? String(policy.clone_depth) : '',
    filter: policy?.clone_filter || '',
    singleBranch: policy?.single_branch === true,
  };
}

/** Workspace 행처럼 원문 JSON 문자열로 저장된 정책을 폼 상태로 읽는다. 깨진 값은 빈 폼. */
export function clonePolicyFormFromRaw(raw: string | null | undefined): ClonePolicyFormState {
  if (!raw) return EMPTY_CLONE_POLICY_FORM;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? clonePolicyToForm(parsed as ClonePolicy) : EMPTY_CLONE_POLICY_FORM;
  } catch {
    return EMPTY_CLONE_POLICY_FORM;
  }
}

const FILTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:=+._-]*$/;

function parseIntField(raw: string, label: string, min: number, max: number):
  { kind: 'absent' } | { kind: 'error'; error: string } | { kind: 'value'; value: number } {
  const t = raw.trim();
  if (!t) return { kind: 'absent' };
  if (!/^\d+$/.test(t)) return { kind: 'error', error: `${label}: 정수만 입력하세요` };
  const n = Number(t);
  if (n < min || n > max) return { kind: 'error', error: `${label}: ${min}~${max} 범위여야 합니다` };
  return { kind: 'value', value: n };
}

/**
 * 폼 → 저장 payload. 모든 칸이 비어 있으면 null(정책 제거)이다. 서버와 같은 범위를
 * 쓰며, 특히 filter 는 `-` 로 시작할 수 없다 — 그런 값이 argv 에 실리면 git 플래그로
 * 해석되기 때문이다.
 */
export function formToClonePolicy(
  form: ClonePolicyFormState,
): { ok: true; value: ClonePolicy | null } | { ok: false; error: string } {
  const timeout = parseIntField(form.timeout, 'Clone timeout (s)', 60, 86400);
  const idle = parseIntField(form.idleTimeout, 'Idle timeout (s)', 0, 86400);
  const depth = parseIntField(form.depth, 'Depth', 1, 1000000);
  for (const field of [timeout, idle, depth]) {
    if (field.kind === 'error') return { ok: false, error: field.error };
  }
  const filter = form.filter.trim();
  if (filter.length > 64) return { ok: false, error: 'Filter: 64자 이하여야 합니다' };
  if (filter && !FILTER_PATTERN.test(filter)) {
    return { ok: false, error: 'Filter: blob:none / tree:0 같은 형태만 허용됩니다' };
  }
  const value: ClonePolicy = {};
  if (timeout.kind === 'value') value.clone_timeout_seconds = timeout.value;
  if (idle.kind === 'value') value.clone_idle_timeout_seconds = idle.value;
  if (depth.kind === 'value') value.clone_depth = depth.value;
  if (filter) value.clone_filter = filter;
  if (form.singleBranch) value.single_branch = true;
  return { ok: true, value: Object.keys(value).length > 0 ? value : null };
}
