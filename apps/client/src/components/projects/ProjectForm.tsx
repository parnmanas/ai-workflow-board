import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import type { Credential, Project } from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Select, Textarea } from '../common';
import { ClonePolicyFields } from '../ClonePolicyEditor';
import DeclareRuntimeSection from '../runtime/DeclareRuntimeSection';
import { specSummary, type RuntimeSpecDraft } from '../../runtime/runtimeSpec';
import {
  buildProjectPayload,
  defaultBranchOptions,
  emptyProjectForm,
  isProjectFormDirty,
  projectCredentialChoices,
  projectToForm,
  testConnectionView,
  type ProjectFormErrors,
  type ProjectFormState,
  type TestConnectionView,
} from '../../projects/projectForm.logic';

// 프로젝트 설정 폼 — 생성/수정 공용. 폼 ⇄ payload 변환·검증은
// projects/projectForm.logic.ts 가 소유한다(React 없이 단위 테스트).

const LABEL: React.CSSProperties = {
  fontSize: tokens.typography.fontSizeXs,
  fontWeight: tokens.typography.fontWeightSemibold,
  color: tokens.colors.textMuted,
  textTransform: 'uppercase',
  display: 'block',
  marginBottom: tokens.spacing.xs,
};
const HELP: React.CSSProperties = { fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.5 };

interface ProjectFormProps {
  /** null = new project. */
  project: Project | null;
  workspaceId: string;
  credentials: Credential[];
  hosts: Array<{ id: string; name: string }>;
  onSaved(project: Project, created: boolean): void;
  onCancel?(): void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export default function ProjectForm({ project, workspaceId, credentials, hosts, onSaved, onCancel, showToast }: ProjectFormProps) {
  const [form, setForm] = useState<ProjectFormState>(() => (project ? projectToForm(project) : emptyProjectForm()));
  const [errors, setErrors] = useState<ProjectFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestConnectionView | null>(null);
  // DeclareRuntimeSection 은 초깃값을 마운트 때 한 번만 읽는다 — 지우기/교체 후
  // 다시 시작하도록 key 를 바꾼다.
  const [assigneeKey, setAssigneeKey] = useState(0);

  const set = (patch: Partial<ProjectFormState>) => setForm((prev) => ({ ...prev, ...patch }));

  // URL/credential 이 바뀌면 이전 테스트 결과는 더 이상 이 대상을 설명하지 않는다.
  useEffect(() => { setTest(null); }, [form.repoUrl, form.credentialId]);

  const credentialChoices = useMemo(
    () => projectCredentialChoices(credentials, workspaceId, form.credentialId),
    [credentials, workspaceId, form.credentialId],
  );
  const dirty = isProjectFormDirty(form, project);
  const hostName = (id: string) => hosts.find((h) => h.id === id)?.name;

  const runTest = async () => {
    const repoUrl = form.repoUrl.trim();
    if (!repoUrl) {
      setErrors((prev) => ({ ...prev, repoUrl: '저장소 URL 을 입력하세요.' }));
      return;
    }
    setTesting(true);
    setTest(null);
    try {
      const result = await api.testProjectConnection({
        repo_url: repoUrl,
        credential_id: form.credentialId || null,
        workspace_id: workspaceId,
      });
      const view = testConnectionView(result);
      setTest(view);
      // 기본 브랜치를 아직 안 정했으면 원격의 기본 브랜치를 바로 채운다.
      if (view.ok && view.suggestedDefault && !form.defaultBranch.trim()) {
        set({ defaultBranch: view.suggestedDefault });
      }
    } catch (err: any) {
      setTest({ ok: false, message: err?.message || '연결에 실패했습니다.', branches: [], suggestedDefault: '' });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const built = buildProjectPayload(form);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const saved = project
        ? await api.updateProject(project.id, built.value)
        : await api.createProject(workspaceId, built.value);
      setForm(projectToForm(saved));
      showToast(project ? '프로젝트를 저장했습니다.' : '프로젝트를 만들었습니다.', 'success');
      onSaved(saved, !project);
    } catch (err: any) {
      showToast(err?.message || '프로젝트를 저장하지 못했습니다.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="project-form" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Input
        label="이름"
        value={form.name}
        onChange={(e) => set({ name: e.target.value })}
        placeholder="예: AI Workflow Board"
        error={errors.name}
      />
      <Input
        label="설명"
        value={form.description}
        onChange={(e) => set({ description: e.target.value })}
        placeholder="한 줄 요약"
      />

      <div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Input
              label="저장소 URL"
              value={form.repoUrl}
              onChange={(e) => set({ repoUrl: e.target.value })}
              placeholder="https://github.com/owner/repo.git"
              error={errors.repoUrl}
            />
          </div>
          <Button
            variant="secondary"
            size="md"
            type="button"
            onClick={() => void runTest()}
            disabled={testing || !form.repoUrl.trim()}
            loading={testing}
          >
            연결 테스트
          </Button>
        </div>
        {test && (
          <div
            data-testid={test.ok ? 'project-test-success' : 'project-test-error'}
            role="status"
            style={{
              fontSize: 12,
              marginTop: 6,
              lineHeight: 1.4,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: test.ok ? tokens.colors.success : tokens.colors.danger,
            }}
          >
            {test.message}
            {test.ok && test.suggestedDefault && test.suggestedDefault !== form.defaultBranch.trim() && (
              <>
                {' '}
                <Button variant="ghost" size="sm" type="button" onClick={() => set({ defaultBranch: test.suggestedDefault })}>
                  기본 브랜치를 {test.suggestedDefault} 로
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <div>
        <Select
          label="Credential"
          value={form.credentialId}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set({ credentialId: e.target.value })}
          options={[
            { value: '', label: '없음 (공개 저장소 / Host 의 git 설정 사용)' },
            ...credentialChoices.map((c) => ({ value: c.id, label: `${c.name} (${c.provider}${c.scope ? `, ${c.scope}` : ''})` })),
            ...(form.credentialId && !credentialChoices.some((c) => c.id === form.credentialId)
              ? [{ value: form.credentialId, label: `알 수 없는 credential (${form.credentialId})` }]
              : []),
          ]}
        />
        <div style={HELP}>clone·push 에 쓰는 워크스페이스 Credential. 연결 테스트도 이 값으로 인증합니다.</div>
      </div>

      <div>
        <label style={LABEL}>기본 브랜치</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Input
              aria-label="기본 브랜치"
              value={form.defaultBranch}
              onChange={(e) => set({ defaultBranch: e.target.value })}
              placeholder="예: main (비우면 origin/HEAD)"
            />
          </div>
          {test?.ok && test.branches.length > 0 && (
            <div style={{ flex: 1, minWidth: 200 }}>
              <Select
                aria-label="원격 브랜치에서 선택"
                value={form.defaultBranch.trim()}
                options={defaultBranchOptions(test.branches, form.defaultBranch)}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set({ defaultBranch: e.target.value })}
              />
            </div>
          )}
        </div>
        <div style={HELP}>
          티켓·실행이 브랜치를 지정하지 않으면 여기서 시작합니다.
          {!test?.ok && ' "연결 테스트" 를 누르면 원격 브랜치 목록에서 고를 수 있습니다.'}
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: tokens.colors.textStrong, cursor: 'pointer' }}>
        <input type="checkbox" checked={form.usePr} onChange={(e) => set({ usePr: e.target.checked })} />
        Pull Request 로 반영 (끄면 직접 fast-forward 머지)
      </label>

      <div>
        <label style={LABEL}>Clone 정책</label>
        <ClonePolicyFields value={form.clonePolicy} onChange={(clonePolicy) => set({ clonePolicy })} error={errors.clonePolicy} />
      </div>

      <div>
        <Textarea
          label="지침 (instructions)"
          value={form.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          rows={6}
          placeholder="빌드/테스트 명령, 코드 규칙 등 — 이 프로젝트를 작업하는 모든 에이전트에게 보여집니다."
        />
      </div>

      <div>
        <label style={LABEL}>기본 담당자 (선택)</label>
        <div style={{ ...HELP, marginTop: 0, marginBottom: 6 }}>
          담당자를 지정하지 않은 이 프로젝트의 새 티켓(UI·MCP·QA/보안 실패 티켓 등)에 적용됩니다.
        </div>
        {form.defaultAssignee ? (
          <div
            data-testid="project-default-assignee"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '6px 10px',
              border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, background: tokens.colors.surface,
            }}
          >
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: tokens.colors.textStrong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {specSummary(form.defaultAssignee, hostName(form.defaultAssignee.manager_agent_id))}
            </span>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => { set({ defaultAssignee: null }); setAssigneeKey((k) => k + 1); }}
            >
              지우기
            </Button>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginBottom: 8 }}>없음 — 새 티켓은 미배정으로 시작합니다.</div>
        )}
        <DeclareRuntimeSection
          key={assigneeKey}
          workspaceId={workspaceId}
          initialValue={form.defaultAssignee}
          onResolved={(spec) => {
            set({ defaultAssignee: spec as RuntimeSpecDraft });
            showToast('기본 담당자를 바꿨습니다. 저장해야 반영됩니다.', 'info');
          }}
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
        {project && dirty && (
          <Button
            variant="ghost"
            type="button"
            disabled={saving}
            onClick={() => { setForm(projectToForm(project)); setErrors({}); setAssigneeKey((k) => k + 1); }}
          >
            되돌리기
          </Button>
        )}
        {onCancel && (
          <Button variant="secondary" type="button" disabled={saving} onClick={onCancel}>취소</Button>
        )}
        <Button variant="primary" type="button" onClick={() => void save()} disabled={saving || (!!project && !dirty)} loading={saving}>
          {project ? '저장' : '프로젝트 만들기'}
        </Button>
      </div>
    </div>
  );
}
