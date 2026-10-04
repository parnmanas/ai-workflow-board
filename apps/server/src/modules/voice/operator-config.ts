import type { DataSource } from 'typeorm';

/**
 * Operator — 사이트를 관리하는 에이전트 하나(docs/voice-operator.md "Operator").
 *
 * 실체는 **고정(pin)된 Agent Session** 이다: 운영자가 Runtime Host · CLI 를 골라 세션을 띄우고
 * (agent-manager 가 실행한다) 그 세션을 operator 로 지정한다. 여기에는 그 세션의 주소만 둔다 —
 * 세션 내용은 AWB 가 저장하지 않는다는 Agent Session 의 원칙 그대로다. CLI 를 바꾸려면 다른 CLI 로
 * 세션을 열고 그것을 다시 지정한다.
 *
 * 저장은 SystemSettings 한 행(`operator.session`, JSON). Admin Settings 의 정의 목록에는 넣지 않는다 —
 * 운영자가 손으로 고칠 값이 아니라 세션 화면의 "Operator" 버튼이 쓰는 값이다.
 */

export const OPERATOR_SETTING_KEY = 'operator.session';

export interface OperatorSession {
  manager_id: string;
  cli: string;
  session_id: string;
  cwd: string;
  title: string;
  pinned_at: string;
  pinned_by: string;
}

function str(v: unknown, max = 512): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 요청 본문 → 저장할 값. 필수 셋(manager_id · cli · session_id) 중 하나라도 비면 null. */
export function parseOperatorInput(body: any, pinnedBy: string, now: Date = new Date()): OperatorSession | null {
  const manager_id = str(body?.manager_id, 128);
  const cli = str(body?.cli, 64);
  const session_id = str(body?.session_id, 256);
  if (!manager_id || !cli || !session_id) return null;
  return { manager_id, cli, session_id, cwd: str(body?.cwd, 1024), title: str(body?.title, 256), pinned_at: now.toISOString(), pinned_by: pinnedBy };
}

export async function readOperator(dataSource: DataSource): Promise<OperatorSession | null> {
  const row: any = await dataSource.getRepository('SystemSetting').findOne({ where: { key: OPERATOR_SETTING_KEY } });
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    return parsed?.manager_id && parsed?.cli && parsed?.session_id ? (parsed as OperatorSession) : null;
  } catch {
    return null;
  }
}

export async function writeOperator(dataSource: DataSource, value: OperatorSession | null): Promise<void> {
  const repo = dataSource.getRepository('SystemSetting');
  const existing: any = await repo.findOne({ where: { key: OPERATOR_SETTING_KEY } });
  const stored = value ? JSON.stringify(value) : '';
  if (existing) {
    existing.value = stored;
    await repo.save(existing);
  } else if (value) {
    await repo.save(repo.create({ key: OPERATOR_SETTING_KEY, value: stored }));
  }
}
