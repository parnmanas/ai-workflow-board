/**
 * Agent Manager 카드의 "버전 액션" 순수 로직 — 어떤 버튼을 어떤 문구로 보여줄지.
 * 컴포넌트에서 분리해 node:test 로 직접 구동한다(viewMode.ts 선례).
 *
 *   - restart:  디스크 설치본(installed_version)이 실행 중(plugin_version)과 다르다 —
 *               `npm i -g` 가 프로세스 밖에서 돌았다. 설치 없이 재기동만 하면 된다.
 *               update_manager 를 보내면 매니저가 설치를 건너뛰고 재기동한다(drain·부팅 검증 포함).
 *   - update:   레지스트리에 더 새 버전이 있다 — 기존 Update.
 *   - latest:   올릴 것이 없다.
 *   - unknown:  구버전 매니저라 업데이트 확인을 보고하지 않는다.
 */
export interface ManagerUpdateActionInput {
  plugin_version: string;
  latest_version?: string | null;
  update_available?: boolean;
  installed_version?: string | null;
  restart_required?: boolean;
  install_mode?: string | null;
  update_skipped_version?: string | null;
  update_failed_version?: string | null;
  update_failure_reason?: string | null;
}

export type ManagerUpdateAction =
  | { kind: 'restart'; label: string; title: string; confirm: string }
  | { kind: 'update'; label: string; title: string; confirm: string }
  | { kind: 'latest'; label: string; title: string }
  | { kind: 'unknown'; label: string; title: string };

export function managerUpdateAction(inst: ManagerUpdateActionInput): ManagerUpdateAction {
  if (inst.restart_required && inst.installed_version) {
    return {
      kind: 'restart',
      label: `Restart to apply v${inst.installed_version}`,
      title:
        `v${inst.installed_version} is already installed on this host but the running manager is still v${inst.plugin_version}. ` +
        'Restarting loads the installed build (no reinstall).',
      confirm:
        `v${inst.installed_version} is already installed on this host (running v${inst.plugin_version}). ` +
        'Restart the manager now to load it? In-flight sessions are drained first.',
    };
  }
  if (inst.update_available) {
    const target = inst.latest_version || '?';
    return {
      kind: 'update',
      label: `Update → v${target}`,
      title:
        inst.install_mode === 'npm-global'
          ? `Update from v${inst.plugin_version} → v${target} (npm i -g --ignore-scripts awb-agent-manager@latest, then restart).`
          : `Update from v${inst.plugin_version} → v${target} (git pull + npm ci + build, then re-exec).`,
      confirm:
        inst.install_mode === 'npm-global'
          ? 'Update this manager? It will reinstall from npm (npm i -g --ignore-scripts awb-agent-manager@latest) and restart.'
          : 'Update this manager? It will pull the latest source, rebuild, and restart.',
    };
  }
  if (inst.update_available === undefined) {
    return { kind: 'unknown', label: '업데이트 확인 불가', title: '이 매니저는 업데이트 확인을 보고하지 않는다 (구버전).' };
  }
  return { kind: 'latest', label: '최신', title: '올릴 것이 없다.' };
}

/** 버전 옆 배지 문구 — restart 가 필요할 때만. */
export function installedVersionBadge(inst: ManagerUpdateActionInput): string | null {
  if (!inst.restart_required || !inst.installed_version) return null;
  return `installed v${inst.installed_version} — restart required`;
}

/**
 * 업데이트 실패 배지 내용 — 실패한 버전만 스킵하고 새 버전 오퍼는 막지 않으므로,
 * "왜 저 버전이 안 뜨나"의 답을 separate 배지로 둔다. 없으면 null.
 */
export function updateFailureBadge(inst: ManagerUpdateActionInput): { label: string; title: string } | null {
  const failed = inst.update_failed_version;
  const reason = inst.update_failure_reason;
  if (!failed && !reason) return null;
  const skipped = inst.update_skipped_version;
  return {
    label: skipped && skipped === failed ? `(v${failed} skipped)` : `(v${failed || '?'} failed before)`,
    title: [
      failed ? `v${failed} failed to update` : 'A previous update failed',
      reason || 'no reason recorded',
      skipped && skipped === failed
        ? 'It is skipped automatically; newer versions are still offered.'
        : 'Newer versions are still offered.',
      'To retry it, delete the pin file on the host (operator only).',
    ].join(' — '),
  };
}
