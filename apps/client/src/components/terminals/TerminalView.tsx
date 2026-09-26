import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useBoardStream, useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { tokens } from '../../tokens';
import type { TerminalOutputEvent, TerminalSummary, TerminalUpdateEvent } from '../../types';
import { decodeBase64, describeTerminalStatus, isLiveTerminal } from './terminalList.logic';

/** 화면에 남기는 안내문(ANSI dim) — 서버가 보낸 바이트와 섞이지 않게 여기서만 만든다. */
const ESC = String.fromCharCode(27);
function dim(text: string): string {
  return `${ESC}[2m${text}${ESC}[0m`;
}

/**
 * 하나의 라이브 터미널 — xterm.js 화면 + 키 입력 + 크기 맞춤.
 *
 * 붙는 순간(attach) 매니저가 들고 있던 스크롤백을 한 번 받아 화면을 되살리고, 그 뒤의
 * 출력은 SSE(`terminal_output`)로 온다. 같은 청크를 두 번 그리지 않도록 스냅샷이 알려
 * 준 seq 이하를 버린다 — 붙는 동안 도착한 청크는 버퍼에 담아 두었다가 스냅샷 뒤에 잇는다.
 *
 * xterm 은 **마운트 시점에 동적으로** 불러온다. 번들을 이 화면에만 지우고, DOM 이 없는
 * 환경이 이 모듈을 import 하는 것만으로 깨지지 않게 한다.
 */
export default function TerminalView({ managerId, terminalId, onTerminalChange }: {
  managerId: string;
  terminalId: string;
  onTerminalChange?: (terminal: TerminalSummary) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const lastSeqRef = useRef(0);
  const attachedRef = useRef(false);
  const bufferedRef = useRef<Array<{ seq: number; data: string }>>([]);
  const inputQueueRef = useRef<string[]>([]);
  const sendingRef = useRef(false);
  const resizeTimerRef = useRef<any>(null);
  const sizeRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 });
  const disposedRef = useRef(false);

  const [terminal, setTerminal] = useState<TerminalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { isConnected } = useBoardStream();
  const wasConnectedRef = useRef(isConnected);

  const writeChunk = useCallback((seq: number, data: string) => {
    if (seq <= lastSeqRef.current) return;
    lastSeqRef.current = seq;
    termRef.current?.write(decodeBase64(data));
  }, []);

  // 키 입력 — 전송 중에 쌓인 것은 다음 회차가 한 번에 가져간다(키 하나당 요청 하나가
  // 되지 않도록). 순서는 큐가 지킨다.
  const flushInput = useCallback(async () => {
    if (sendingRef.current || !inputQueueRef.current.length) return;
    sendingRef.current = true;
    const data = inputQueueRef.current.join('');
    inputQueueRef.current = [];
    try {
      await api.writeHostTerminal(managerId, terminalId, data);
    } catch (err: any) {
      setError(err?.message || 'Failed to send input');
    } finally {
      sendingRef.current = false;
      if (inputQueueRef.current.length) void flushInput();
    }
  }, [managerId, terminalId]);

  const pushResize = useCallback((cols: number, rows: number) => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      api.resizeHostTerminal(managerId, terminalId, cols, rows).catch(() => undefined);
    }, 150);
  }, [managerId, terminalId]);

  /** 스크롤백을 받아 화면을 다시 그리고 driver 를 (되)잡는다. 재접속에도 같은 경로를 쓴다. */
  const attach = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    setLoading(true);
    try {
      fitRef.current?.fit();
      const size = { cols: term.cols || 80, rows: term.rows || 24 };
      sizeRef.current = size;
      const snapshot = await api.attachHostTerminal(managerId, terminalId, size);
      if (disposedRef.current) return;
      term.reset();
      if (snapshot.truncated) term.write(`${dim('[earlier output trimmed]')}\r\n`);
      term.write(decodeBase64(snapshot.data));
      lastSeqRef.current = snapshot.seq;
      attachedRef.current = true;
      // 붙는 동안 도착해 버퍼에 담긴 청크를 순서대로 잇는다.
      const buffered = bufferedRef.current.sort((a, b) => a.seq - b.seq);
      bufferedRef.current = [];
      for (const chunk of buffered) writeChunk(chunk.seq, chunk.data);
      setTerminal(snapshot.terminal);
      onTerminalChange?.(snapshot.terminal);
      setError(null);
    } catch (err: any) {
      if (!disposedRef.current) setError(err?.message || 'Failed to attach to this terminal');
    } finally {
      if (!disposedRef.current) setLoading(false);
    }
  }, [managerId, terminalId, writeChunk, onTerminalChange]);

  // ─── xterm 생성/파기 ───────────────────────────────────────────────────
  useEffect(() => {
    disposedRef.current = false;
    attachedRef.current = false;
    lastSeqRef.current = 0;
    bufferedRef.current = [];
    let observer: ResizeObserver | null = null;
    let disposeData: { dispose: () => void } | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposedRef.current || !hostRef.current) return;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        scrollback: 5000,
        theme: {
          background: '#0b0e14',
          foreground: '#d5dae3',
          cursor: '#9fb4ff',
          selectionBackground: '#2f3a55',
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      termRef.current = term;
      fitRef.current = fit;
      disposeData = term.onData((data: string) => {
        inputQueueRef.current.push(data);
        void flushInput();
      });
      observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          return;
        }
        const cols = term.cols;
        const rows = term.rows;
        if (cols === sizeRef.current.cols && rows === sizeRef.current.rows) return;
        sizeRef.current = { cols, rows };
        pushResize(cols, rows);
      });
      observer.observe(hostRef.current);
      await attach();
      term.focus();
    })().catch((err: any) => {
      if (!disposedRef.current) {
        setError(err?.message || 'Failed to load the terminal view');
        setLoading(false);
      }
    });

    return () => {
      disposedRef.current = true;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      observer?.disconnect();
      disposeData?.dispose();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // attach / flushInput / pushResize 는 (managerId, terminalId) 로만 바뀐다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerId, terminalId]);

  // ─── 라이브 출력 ────────────────────────────────────────────────────────
  useBoardStreamEvent('terminal_output', useCallback((raw: TerminalOutputEvent) => {
    if (raw?.manager_id !== managerId || raw?.terminal_id !== terminalId) return;
    const chunk = raw.chunk;
    if (!chunk?.data) return;
    // 아직 스냅샷을 못 받았으면 버퍼에 둔다 — 순서가 어긋나면 화면이 깨진다.
    if (!attachedRef.current) {
      bufferedRef.current.push({ seq: chunk.seq, data: chunk.data });
      return;
    }
    writeChunk(chunk.seq, chunk.data);
  }, [managerId, terminalId, writeChunk]));

  useBoardStreamEvent('terminal_update', useCallback((raw: TerminalUpdateEvent) => {
    const next = raw?.terminal;
    if (!next || next.manager_id !== managerId || next.terminal_id !== terminalId) return;
    setTerminal(next);
    onTerminalChange?.(next);
    if (!isLiveTerminal(next)) {
      const code = next.exit_code !== null && next.exit_code !== undefined ? ` (code ${next.exit_code})` : '';
      termRef.current?.write(`\r\n${dim(`[terminal exited${code}]`)}\r\n`);
    }
  }, [managerId, terminalId, onTerminalChange]));

  // SSE 가 끊겼다 붙으면 그동안의 출력을 놓쳤다 — 스크롤백으로 메꾸고 driver 를 되찾는다.
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current && attachedRef.current) void attach();
    wasConnectedRef.current = isConnected;
  }, [isConnected, attach]);

  const status = describeTerminalStatus(terminal?.status);
  const dead = !!terminal && !isLiveTerminal(terminal);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {error && (
        <div style={{ padding: '6px 12px', fontSize: 12, color: tokens.colors.dangerLight, background: `${tokens.colors.dangerLight}12`, borderBottom: `1px solid ${tokens.colors.border}` }}>
          {error}
        </div>
      )}
      {dead && (
        <div style={{ padding: '6px 12px', fontSize: 12, color: tokens.colors.textMuted, borderBottom: `1px solid ${tokens.colors.border}` }}>
          {status.label}
          {terminal?.exit_code !== null && terminal?.exit_code !== undefined ? ` — exit code ${terminal.exit_code}` : ''}
          {' · this terminal is gone; open a new one.'}
        </div>
      )}
      <div
        ref={hostRef}
        data-testid="terminal-surface"
        style={{ flex: 1, minHeight: 0, background: '#0b0e14', padding: 8, overflow: 'hidden' }}
      />
      {loading && (
        <div style={{ padding: '4px 12px', fontSize: 11.5, color: tokens.colors.textMuted }}>Attaching…</div>
      )}
    </div>
  );
}
