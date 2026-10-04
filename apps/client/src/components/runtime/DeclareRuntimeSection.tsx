import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { Button } from '../common';
import { tokens } from '../../tokens';
import { useToast } from '../../contexts/ToastContext';
import RuntimeSpecEditor, { emptyRuntimeSpec, type RuntimeHostChoice, type RuntimeSpecDraft } from './RuntimeSpecEditor';

import { isRuntimeSpecComplete } from '../../runtime/runtimeSpec';

interface DeclareRuntimeSectionProps {
  workspaceId: string;
  initialValue?: Record<string, any> | null;
  onResolved(spec: Record<string, any>): void;
}

/**
 * DeclareRuntimeSection — P4c-4 runtime 선언 UI.
 *
 * Runtime 선언 → validate → 정규화 spec 을 호출자에게 돌려준다 (spec-direct,
 * Agent 행 없음). Host 후보는 runtime-hosts 카탈로그에서 직접 읽는다.
 */
export default function DeclareRuntimeSection({ workspaceId, onResolved, initialValue }: DeclareRuntimeSectionProps) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RuntimeSpecDraft>(() => ({ ...emptyRuntimeSpec(), ...initialValue }));
  const [resolving, setResolving] = useState(false);
  const [hosts, setHosts] = useState<RuntimeHostChoice[]>([]);

  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    api.listTemplateHosts()
      .then((rows) => {
        if (cancelled) return;
        setHosts((rows || []).map((h: any) => ({
          id: h.id,
          name: h.name || h.id.slice(0, 8),
        })));
      })
      .catch(() => { if (!cancelled) setHosts([]); });
    return () => { cancelled = true; };
  }, [open, workspaceId]);

  const handleResolve = async () => {
    if (!isRuntimeSpecComplete(draft)) {
      showToast('Host·CLI·절대경로를 모두 입력하세요', 'error');
      return;
    }
    setResolving(true);
    try {
      const result = await api.validateRuntimeSpec(workspaceId, draft);
      if (!result.ok || !result.spec) throw new Error(result.error || 'Invalid runtime');
      onResolved(result.spec);
    } catch (err: any) {
      showToast(err?.message || 'Runtime 해석에 실패했습니다', 'error');
    } finally {
      setResolving(false);
    }
  };

  return (
    <div style={{ border: `1px dashed ${tokens.colors.border}`, borderRadius: tokens.radii.sm, padding: 10 }}>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
        <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
        실행 설정
      </label>
      {open && (
        <div style={{ marginTop: 10 }}>
          <RuntimeSpecEditor
            value={draft}
            onChange={setDraft}
            hosts={hosts}
            workspaceId={workspaceId}
            disabled={resolving}
          />
          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" size="sm" onClick={handleResolve} disabled={resolving}>
              {resolving ? '해석 중…' : '이 설정 사용'}
            </Button>
          </div>
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 6 }}>
            설정을 이 작업에 복사합니다. 작업 폴더는 이 실행에만 적용됩니다.
          </div>
        </div>
      )}
    </div>
  );
}
