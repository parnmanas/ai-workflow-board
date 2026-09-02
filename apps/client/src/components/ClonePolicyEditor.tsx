import React, { useEffect, useState } from 'react';
import { ClonePolicy } from '../types';
import { tokens } from '../tokens';
import { Button } from './common';

// Repo clone 정책 에디터 (ticket bddb63ee).
//
// 두 표면이 **같은 ClonePolicy 형태**를 편집한다 — Resource 설정(repo별 override)과
// Workspace Settings(워크스페이스 기본값) — 저장 대상만 다르다. 그래서 필드 구성과
// 입력 검증을 여기 한 곳에 두고, ResourceManager 는 필드 그리드를,
// WorkspaceSettingsPage 는 저장 버튼까지 포함한 기본 export 를 쓴다. 검증이 두 벌로
// 갈라지면 한쪽만 조용히 낡기 때문이다.
//
// 서버 zod 가 최종 검증 권한이며, 여기서는 사용자가 **어느 칸이 잘못됐는지** 알 수
// 있도록 같은 범위를 미리 확인할 뿐이다. 빈 칸은 "미지정"이라 저장 payload 에서 키
// 자체가 빠지고, 그러면 Repo Resource → Workspace → 시스템 기본값 순으로 흘러내린다
// (그래서 0 과 미지정을 구분해야 하고, 상태를 문자열로 들고 있다).

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

const FIELD_STYLE: React.CSSProperties = {
  background: tokens.colors.surface,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.md,
  padding: '8px 10px',
  color: tokens.colors.textStrong,
  fontSize: tokens.typography.fontSizeMd,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

interface ClonePolicyFieldsProps {
  value: ClonePolicyFormState;
  onChange(next: ClonePolicyFormState): void;
  /** 검증 실패 메시지 — 저장을 시도한 호출자가 내려준다. */
  error?: string;
}

/** 필드 그리드만 렌더한다 — 자체 저장 버튼이 없는 폼(Resource 설정)에 끼워 쓴다. */
export function ClonePolicyFields({ value, onChange, error }: ClonePolicyFieldsProps) {
  const fields = [
    { key: 'timeout' as const, label: 'Clone timeout (s)', placeholder: '3600' },
    { key: 'idleTimeout' as const, label: 'Idle timeout (s)', placeholder: '600 (0 = off)' },
    { key: 'depth' as const, label: 'Depth', placeholder: 'full history' },
    { key: 'filter' as const, label: 'Filter', placeholder: 'e.g. blob:none' },
  ];
  return (
    <div>
      <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginBottom: tokens.spacing.sm }}>
        {`비워두면 상위 기본값으로 흘러내립니다 (Repo Resource → Workspace → 시스템 기본값: clone timeout 3600초, idle timeout 600초, 전체 clone). 대형 저장소는 timeout을 늘리거나 depth/filter/single-branch로 clone 자체를 줄이세요.`}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: tokens.spacing.sm }}>
        {fields.map((field) => (
          <div key={field.key}>
            <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginBottom: 2 }}>{field.label}</div>
            <input
              value={value[field.key]}
              onChange={(e) => onChange({ ...value, [field.key]: e.target.value })}
              placeholder={field.placeholder}
              style={FIELD_STYLE}
            />
          </div>
        ))}
      </div>
      <label style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing.xs,
        marginTop: tokens.spacing.sm,
        fontSize: tokens.typography.fontSizeMd,
        color: tokens.colors.textStrong,
      }}>
        <input
          type="checkbox"
          checked={value.singleBranch}
          onChange={(e) => onChange({ ...value, singleBranch: e.target.checked })}
        />
        {`single-branch clone (대상 브랜치만 가져옴 — 다른 브랜치를 base로 쓰는 티켓은 이 저장소에서 체크아웃할 수 없게 됩니다)`}
      </label>
      {error && (
        <div style={{ fontSize: '11px', color: tokens.colors.danger, marginTop: 4 }}>{error}</div>
      )}
    </div>
  );
}

interface ClonePolicyEditorProps {
  /** 행에 저장된 clone_policy 원문 JSON 문자열. */
  raw: string | null | undefined;
  title: string;
  description: React.ReactNode;
  onSave(next: ClonePolicy | null): Promise<void>;
}

/** 자체 저장 버튼을 가진 독립 섹션 — Workspace Settings 용(HarnessConfigEditor 와 같은 모양). */
export default function ClonePolicyEditor({ raw, title, description, onSave }: ClonePolicyEditorProps) {
  const [form, setForm] = useState<ClonePolicyFormState>(() => clonePolicyFormFromRaw(raw));
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  // 저장 후 상위가 re-fetch 하면 raw 가 바뀐다 — 그때 폼을 서버 값으로 다시 맞춘다.
  useEffect(() => { setForm(clonePolicyFormFromRaw(raw)); setError(undefined); }, [raw]);

  const save = async () => {
    const built = formToClonePolicy(form);
    if (!built.ok) { setError(built.error); return; }
    setError(undefined);
    setSaving(true);
    try {
      await onSave(built.value);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      style={{
        padding: 16,
        marginBottom: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>{title}</h3>
      <div style={{ fontSize: 12, color: tokens.colors.textSecondary, margin: '6px 0 12px', lineHeight: 1.5 }}>
        {description}
      </div>
      <ClonePolicyFields value={form} onChange={setForm} error={error} />
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button variant="primary" size="sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={saving}
          onClick={() => setForm(EMPTY_CLONE_POLICY_FORM)}
        >
          Clear fields
        </Button>
      </div>
    </section>
  );
}
