import React, { useEffect, useState } from 'react';
import { ClonePolicy } from '../types';
import { tokens } from '../tokens';
import { Button } from './common';
import {
  EMPTY_CLONE_POLICY_FORM,
  clonePolicyFormFromRaw,
  formToClonePolicy,
  type ClonePolicyFormState,
} from './clonePolicy.logic';

// Repo clone 정책 에디터 (ticket bddb63ee).
//
// 두 표면이 **같은 ClonePolicy 형태**를 편집한다 — Resource 설정(repo별 override)과
// Workspace Settings(워크스페이스 기본값) — 저장 대상만 다르다. 그래서 ResourceManager
// 는 필드 그리드(ClonePolicyFields)를, WorkspaceSettingsPage 는 저장 버튼까지 포함한
// 기본 export 를 쓴다. 폼 매핑·검증은 clonePolicy.logic.ts 가 소유한다(jsdom 없이
// 단위 테스트하기 위한 분리 — environmentConfig.logic.ts 와 같은 관례).

export {
  EMPTY_CLONE_POLICY_FORM,
  clonePolicyToForm,
  clonePolicyFormFromRaw,
  formToClonePolicy,
} from './clonePolicy.logic';
export type { ClonePolicyFormState } from './clonePolicy.logic';

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
    { key: 'idleTimeout' as const, label: 'Idle timeout (s)', placeholder: 'off (0 = off)' },
    { key: 'depth' as const, label: 'Depth', placeholder: 'full history' },
    { key: 'filter' as const, label: 'Filter', placeholder: 'e.g. blob:none' },
  ];
  return (
    <div>
      <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginBottom: tokens.spacing.sm }}>
        {`비워두면 상위 기본값으로 흘러내립니다 (Repo Resource → Workspace → 시스템 기본값: clone timeout 3600초, idle 감시 없음, 전체 clone). 대형 저장소는 timeout을 늘리거나 depth/filter/single-branch로 clone 자체를 줄이세요. idle timeout은 값을 넣었을 때만 켜집니다 — 진행 출력이 그 시간만큼 완전히 끊긴 clone을 정지로 보고 회수합니다.`}
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
