import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { Select } from '../common/Select';
import type { Workspace } from '../../types';
import { eligibleAssistantAgents, type AssistantAgentInfo } from './assistantEntry';

/**
 * 워크스페이스 설정 · AWB 어시스턴트 지정 (에픽 bf65ca00 · Phase 1 · S2).
 *
 * 관리자가 Chat-first 기본 진입이 연결할 어시스턴트 에이전트를 지정한다. 서버 검증과
 * 동일한 적격성(활성·비매니저·이 워크스페이스 소속)만 후보로 노출하고, 저장은 관리자
 * 전용 workspace PATCH(`assistant_agent_id`)로 나간다(planner 결정 a). '지정 안 함'을
 * 고르면 null 로 해제 → 랜딩은 empty state 로 돌아간다.
 *
 * 컨테이너/뷰 분리 — 순수 <AssistantAgentSettingView> 는 react-dom/server 로 옵션·빈
 * 상태 마크업을 검증하고, agents fetch·save 는 컨테이너가 담당한다.
 */

const UNSET_VALUE = '';

export function AssistantAgentSettingView({
  agents,
  value,
  dirty,
  saving,
  onChange,
  onSave,
}: {
  agents: AssistantAgentInfo[];
  value: string;
  dirty: boolean;
  saving: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  const options = [
    { value: UNSET_VALUE, label: '— 지정 안 함 —' },
    ...agents.map((a) => ({ value: a.id, label: a.name })),
  ];
  // 현재 지정값이 적격 목록에 없으면(삭제·비활성) 무효 지정임을 명시적으로 표시한다.
  const staleValue = value !== UNSET_VALUE && !agents.some((a) => a.id === value);

  return (
    <div
      style={{
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.lg,
        padding: tokens.spacing.lg,
        marginBottom: tokens.spacing.lg,
        background: tokens.colors.surfaceCard,
      }}
    >
      <h3 style={{ margin: 0, fontSize: tokens.typography.fontSizeXl, fontWeight: 700, color: tokens.colors.textStrong }}>
        AWB 어시스턴트
      </h3>
      <p style={{ margin: `${tokens.spacing.xs}px 0 ${tokens.spacing.md}px`, fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary, lineHeight: 1.6 }}>
        Chat-first 기본 진입 화면이 이 에이전트와의 DM 으로 연결됩니다. 사용자가 자연어로 말하면 어시스턴트가
        멘션 없이 응답합니다. 활성 상태의 이 워크스페이스 에이전트만 지정할 수 있으며(매니저 제외), 지정하지 않으면
        랜딩은 지정 안내 화면을 보여줍니다.
      </p>

      {agents.length === 0 && !staleValue ? (
        <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textMuted }}>
          지정 가능한 활성 에이전트가 없습니다. 먼저 이 워크스페이스에 에이전트를 추가하세요.
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: tokens.spacing.sm, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 260 }}>
            <Select
              label="어시스턴트 에이전트"
              options={options}
              value={value}
              onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
              disabled={saving}
            />
          </div>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || saving}
            style={{
              padding: '8px 18px',
              fontSize: tokens.typography.fontSizeMd,
              fontWeight: 600,
              fontFamily: 'inherit',
              color: tokens.colors.textInverse,
              background: tokens.colors.accent,
              border: 'none',
              borderRadius: tokens.radii.md,
              cursor: !dirty || saving ? 'default' : 'pointer',
              opacity: !dirty || saving ? 0.6 : 1,
            }}
          >
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      )}

      {staleValue && (
        <div role="alert" style={{ marginTop: tokens.spacing.sm, fontSize: 12, color: tokens.colors.danger }}>
          현재 지정된 에이전트를 사용할 수 없습니다 (삭제·비활성). 다른 에이전트로 다시 지정하거나 지정을 해제하세요.
        </div>
      )}
    </div>
  );
}

/** 컨테이너 — 적격 에이전트를 로드하고 PATCH 로 저장. */
export default function AssistantAgentSetting({
  workspace,
  onSaved,
}: {
  workspace: Workspace;
  onSaved: () => void;
}) {
  const [agents, setAgents] = useState<AssistantAgentInfo[]>([]);
  const [value, setValue] = useState<string>(workspace.assistant_agent_id || UNSET_VALUE);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setValue(workspace.assistant_agent_id || UNSET_VALUE);
  }, [workspace.assistant_agent_id]);

  useEffect(() => {
    let cancelled = false;
    api
      .getAgents()
      .then((rows) => {
        if (!cancelled) setAgents(eligibleAssistantAgents(rows as any, workspace.id));
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  const dirty = value !== (workspace.assistant_agent_id || UNSET_VALUE);

  const onSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateWorkspace(workspace.id, { assistant_agent_id: value || null });
      onSaved();
    } catch (err: any) {
      setSaveError(err?.message || '저장에 실패했습니다');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <AssistantAgentSettingView
        agents={agents}
        value={value}
        dirty={dirty}
        saving={saving}
        onChange={setValue}
        onSave={onSave}
      />
      {saveError && (
        <div role="alert" style={{ marginTop: -tokens.spacing.md, marginBottom: tokens.spacing.lg, fontSize: 12, color: tokens.colors.danger }}>
          {saveError}
        </div>
      )}
    </>
  );
}
