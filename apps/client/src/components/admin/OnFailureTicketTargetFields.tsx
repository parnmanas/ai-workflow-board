import React from 'react';
import { tokens } from '../../tokens';
import { Select } from '../common';
import { TagInput } from '../common/TagInput';
import { useProjects } from '../../projects/useProjects';
import { TICKET_PRIORITIES, TICKET_STATUS_LABELS } from '../../tickets/status';
import type { OnFailureTicketStatus, TicketPriority } from '../../types';
import {
  ON_FAILURE_TICKET_STATUSES,
  projectSelectOptions,
  type OnFailureTicketDedupe,
  type OnFailureTicketForm,
} from './onFailureTicket.logic';

// "Where does the auto-filed fix ticket land" — shared by the QA scenario and
// Security profile editors (docs/tickets.md → QA / Security failure tickets):
// the ticket joins the workspace pool with a status, tags and an optional
// project.

interface Props {
  accountId: string;
  form: OnFailureTicketForm;
  onChange: (patch: Partial<OnFailureTicketForm>) => void;
  /** Shown under the tags input — what the server files when tags are empty. */
  defaultTagsHint: string;
}

export default function OnFailureTicketTargetFields({ accountId, form, onChange, defaultTagsHint }: Props) {
  const { projects, loading, error } = useProjects(accountId);
  const projectOptions = projectSelectOptions(projects, form.projectId, loading ? '(불러오는 중…)' : '(프로젝트 없음)');

  return (
    <>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <Select
            label="Priority"
            value={form.priority}
            options={TICKET_PRIORITIES.map((p) => ({ value: p, label: p }))}
            onChange={(e) => onChange({ priority: (e.target as HTMLSelectElement).value as TicketPriority })}
          />
        </div>
        <div style={{ flex: 1 }}>
          <Select
            label="생성 상태 (status)"
            value={form.status}
            options={ON_FAILURE_TICKET_STATUSES.map((s) => ({ value: s, label: TICKET_STATUS_LABELS[s] }))}
            onChange={(e) => onChange({ status: (e.target as HTMLSelectElement).value as OnFailureTicketStatus })}
          />
        </div>
        <div style={{ flex: 1 }}>
          <Select
            label="중복 방지 (dedupe)"
            value={form.dedupe}
            options={[
              { value: 'per_run', label: 'per_run (run당 1개)' },
              { value: 'per_open_ticket', label: 'per_open_ticket (열린 티켓에 코멘트)' },
            ]}
            onChange={(e) => onChange({ dedupe: (e.target as HTMLSelectElement).value as OnFailureTicketDedupe })}
          />
        </div>
      </div>
      <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginTop: -4 }}>
        To Do 는 담당 에이전트에게 바로 디스패치되고, Backlog 는 사람이 To Do 로 옮길 때까지 대기합니다.
      </div>

      <div>
        <Select
          label="프로젝트 (선택)"
          value={form.projectId}
          options={projectOptions}
          onChange={(e) => onChange({ projectId: (e.target as HTMLSelectElement).value })}
        />
        <div style={{ fontSize: 12, color: error ? tokens.colors.danger : tokens.colors.textMuted, marginTop: 4 }}>
          {error
            ? `프로젝트 목록을 불러오지 못했습니다: ${error}`
            : '티켓이 다룰 저장소. 실행 설정을 비우면 타깃 설정 → 이 프로젝트의 기본 담당자 순으로 배정됩니다.'}
        </div>
      </div>

      <div>
        <TagInput
          label="티켓 태그"
          value={form.tags}
          onChange={(tags) => onChange({ tags })}
          placeholder="태그 입력 후 Enter (쉼표로 여러 개)"
        />
        <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginTop: 4 }}>
          {form.tags.length > 0 ? '생성되는 티켓에 이 태그가 붙습니다.' : defaultTagsHint}
        </div>
      </div>
    </>
  );
}
