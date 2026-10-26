import { t as translate, getLocale } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import type { CliMemorySnapshot, MemoryHostSnapshot } from '../../types';
import { Button, Modal } from '../common';
import { optimizationPrompt, type MemoryFinding } from './memoryAnalysis.logic';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * "에이전트로 최적화" — 그 CLI 의 Agent Session 을 이 장비에 열고, 분석 결과를 근거로 메모리를 정리하라는
 * 지시를 보낸다. 판단(무엇이 낡았는가, 어떻게 합칠까)은 CLI 자신에게 맡긴다 — 자기 메모리 형식을 가장 잘
 * 아는 것이 그 CLI 다. 결과는 세션 화면에서 보고, 바뀐 파일은 여기서 Refresh 하면 분석이 다시 돈다.
 */
export default function MemoryOptimizeModal({ snapshot, cli, findings, onClose }: {
  snapshot: MemoryHostSnapshot;
  cli: CliMemorySnapshot;
  findings: MemoryFinding[];
  onClose: () => void;
}) {
  useLocale();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [canRun, setCanRun] = useState<boolean | null>(null);
  const operatorHome = cli.homes.find((h) => h.id === 'operator');
  const options = useMemo(() => {
    const dirs = snapshot.project_dirs.filter((p) => cli.files.some((f) => f.exists && f.project_dir === p.path));
    return [
      ...dirs.map((p) => ({ value: p.path, label: `${p.project_name} — ${p.path}`, projectDir: p.path as string | null })),
      ...(operatorHome ? [{ value: operatorHome.path, label: translate('Global only — {0}', { 0: operatorHome.display_path }), projectDir: null as string | null }] : []),
    ];
  }, [snapshot.project_dirs, cli.files, operatorHome, getLocale()]);
  const [cwd, setCwd] = useState(options[0]?.value ?? '');
  const projectDir = options.find((o) => o.value === cwd)?.projectDir ?? null;
  const generated = useMemo(() => optimizationPrompt(cli, findings, { projectDir }), [cli, findings, projectDir, getLocale()]);
  const [prompt, setPrompt] = useState(generated);
  const [edited, setEdited] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => { if (!edited) setPrompt(generated); }, [generated, edited]);

  useEffect(() => {
    let cancelled = false;
    api.listAgentSessionHosts()
      .then((hosts) => { if (!cancelled) setCanRun(hosts.some((h) => h.manager_id === snapshot.manager_id && h.clis.includes(cli.cli))); })
      .catch(() => { if (!cancelled) setCanRun(false); });
    return () => { cancelled = true; };
  }, [snapshot.manager_id, cli.cli]);

  const start = async () => {
    if (!cwd || !prompt.trim()) return;
    setStarting(true);
    try {
      const session = await api.openHostSession(snapshot.manager_id, cli.cli, { cwd, title: translate('Memory optimization · {0}', { 0: cli.label }) });
      await api.promptHostSession(snapshot.manager_id, cli.cli, session.session_id, prompt);
      showToast(translate('Session started — Refresh the memory page when it finishes.'), 'success');
      navigate(`/sessions/${encodeURIComponent(snapshot.manager_id)}/${encodeURIComponent(cli.cli)}/${encodeURIComponent(session.session_id)}`);
    } catch (err: any) {
      showToast(err?.message || translate('Could not start the session.'), 'error');
      setStarting(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={translate('Optimize {0} memory with an agent', { 0: cli.label })}
      maxWidth={860}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{translate('Cancel')}</Button>
          <Button variant="primary" disabled={!canRun || !cwd || !prompt.trim() || starting} onClick={start}>
            {starting ? translate('Starting…') : translate('Start session')}
          </Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12.5, color: tokens.colors.textPrimary }}>
        <div style={{ color: tokens.colors.textSecondary }}>
          {translate('Opens a new')} {cli.label} {translate('session on')} {snapshot.manager_name} {translate('and asks it to clean up its own memory using the findings below. Every file it touches is still the CLI\'s own — AWB\'s History only covers edits made from this page.')}</div>
        {canRun === false && (
          <div style={{ color: tokens.colors.danger }}>
            {translate('Agent Sessions cannot run')} {cli.label} {translate('on this host (no ACP session adapter, or you lack the Agent Sessions permission).')}</div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {translate('Working folder')}<select
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            style={{ flex: 1, minWidth: 0, fontSize: 12.5, padding: '4px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary }}
          >
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontWeight: 600 }}>{translate('Instructions')}</span>
          {edited && (
            <button type="button" onClick={() => { setEdited(false); setPrompt(generated); }} style={{ marginLeft: 'auto', border: 'none', background: 'none', color: tokens.colors.accentSubtle, cursor: 'pointer', fontSize: 11.5 }}>
              {translate('Reset to generated')}</button>
          )}
        </div>
        <textarea
          value={prompt}
          onChange={(e) => { setPrompt(e.target.value); setEdited(true); }}
          rows={18}
          spellCheck={false}
          style={{ width: '100%', boxSizing: 'border-box', fontFamily: MONO, fontSize: 11.5, lineHeight: 1.5, padding: '8px 10px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, resize: 'vertical' }}
        />
      </div>
    </Modal>
  );
}
