import React, { useMemo, useState } from 'react';
import { api } from '../../api';
import type { Project } from '../../types';
import { tokens } from '../../tokens';
import { Badge, Button, Input } from '../common';
import DirectoryPicker from '../admin/DirectoryPicker';
import { hostFolderPathError, hostFolderRows, type HostFolderRow } from '../../projects/projectForm.logic';

// 프로젝트의 Runtime Host 별 "메인 클론 폴더"(docs/tickets.md → Main clone folder
// per host). Host 하나당 한 행 — 그 Host 에서 이 프로젝트가 체크아웃돼 있는 절대
// 경로다. 티켓 worktree 는 여기서 잘라내고(`<main_clone>/.awb/wt/<ticket8>`),
// 미션 step / 팀 슬롯의 "프로젝트 폴더 사용" 도 이 값을 읽는다.
//
// Host 목록에 없는 host_id 의 폴더(오프라인·삭제된 Host)도 행으로 남긴다 — 그래야
// 운영자가 그 폴더를 지울 수 있다.

interface ProjectHostFoldersProps {
  project: Project;
  hosts: Array<{ id: string; name: string }>;
  hostsLoading: boolean;
  /** Called with the server's updated project after a save/clear. */
  onSaved(project: Project): void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export default function ProjectHostFolders({ project, hosts, hostsLoading, onSaved, showToast }: ProjectHostFoldersProps) {
  const rows = useMemo(() => hostFolderRows(hosts, project.host_folders), [hosts, project.host_folders]);

  if (hostsLoading && rows.length === 0) {
    return <div style={{ fontSize: 13, color: tokens.colors.textSecondary, padding: '12px 0' }}>Runtime Host 목록을 불러오는 중…</div>;
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: tokens.colors.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
        각 Runtime Host 에서 이 프로젝트가 체크아웃돼 있는 <b>메인 클론 폴더</b>(절대 경로)입니다. 티켓 작업은 이
        폴더에서 worktree 를 잘라 진행하고, 미션 step·팀 슬롯은 이 경로를 작업 폴더로 씁니다. 폴더가 없는 Host 에서는
        에이전트가 프로젝트 위치를 추측하지 않도록 비워 두세요.
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: '12px 0' }}>
          연결된 Runtime Host 가 없습니다. Hosts 화면에서 Agent Manager 를 페어링하면 여기에 나타납니다.
        </div>
      ) : (
        <div
          data-testid="project-host-folders"
          style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, overflow: 'hidden' }}
        >
          {rows.map((row, idx) => (
            <HostFolderRowEditor
              // key = host + 저장값: 저장/지우기 후 서버 값으로 draft 를 다시 시작한다.
              key={`${row.host_id}::${row.saved_path}`}
              row={row}
              first={idx === 0}
              projectId={project.id}
              onSaved={onSaved}
              showToast={showToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HostFolderRowEditor({
  row,
  first,
  projectId,
  onSaved,
  showToast,
}: {
  row: HostFolderRow;
  first: boolean;
  projectId: string;
  onSaved(project: Project): void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [draft, setDraft] = useState(row.saved_path);
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [touched, setTouched] = useState(false);

  const trimmed = draft.trim();
  const dirty = trimmed !== row.saved_path;
  const error = touched && dirty ? hostFolderPathError(draft) : null;

  const save = async () => {
    setTouched(true);
    if (hostFolderPathError(draft)) return;
    setBusy('save');
    try {
      const updated = await api.setProjectHostFolder(projectId, row.host_id, trimmed);
      showToast(`${row.host_name} 폴더를 저장했습니다.`, 'success');
      onSaved(updated);
    } catch (err: any) {
      showToast(err?.message || '폴더를 저장하지 못했습니다.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy('clear');
    try {
      const updated = await api.clearProjectHostFolder(projectId, row.host_id);
      showToast(`${row.host_name} 폴더 지정을 지웠습니다.`, 'success');
      onSaved(updated);
    } catch (err: any) {
      showToast(err?.message || '폴더를 지우지 못했습니다.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-testid={`project-host-folder-${row.host_id}`}
      style={{
        padding: '10px 12px',
        borderTop: first ? 'none' : `1px solid ${tokens.colors.border}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.textStrong }}>{row.host_name}</span>
        {!row.known && <Badge variant="warning">알 수 없는 Host</Badge>}
        {row.saved_path
          ? <Badge variant="success" dot>지정됨</Badge>
          : <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>폴더 없음</span>}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <Input
            aria-label={`${row.host_name} 메인 클론 폴더`}
            value={draft}
            placeholder="/home/user/repos/project"
            error={error || undefined}
            onChange={(e) => { setDraft(e.target.value); setTouched(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && dirty) { e.preventDefault(); void save(); } }}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={!row.known || busy !== null}
          title={row.known ? undefined : '목록에 없는 Host 는 폴더를 탐색할 수 없습니다'}
          onClick={() => setPickerOpen(true)}
        >
          찾아보기
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || !trimmed || busy !== null}
          loading={busy === 'save'}
          onClick={() => void save()}
        >
          저장
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!row.saved_path || busy !== null}
          loading={busy === 'clear'}
          onClick={() => void clear()}
        >
          지우기
        </Button>
      </div>
      {row.known && (
        <DirectoryPicker
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          managerAgentId={row.host_id}
          initialPath={trimmed || undefined}
          onPick={(path) => {
            setDraft(path);
            setTouched(true);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
