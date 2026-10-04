import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, Input, Modal } from '../components/common';
import { tokens } from '../tokens';
import type { VoiceOperator } from '../types';
import { startHandsFree, type HandsFreeSession } from './handsFree';
import { announceOperatorsChanged, parseAliasInput } from './operator';
import { voiceRecordingSupported } from './recorder';
import { heardName, matchWake, withVocative } from './wake.logic';
import { wakeStore } from './wakeState';

/** 불러 보기 — 말을 기다리는 최대 시간. */
const TEST_LISTEN_MS = 8_000;

type TestState =
  | { phase: 'idle' }
  | { phase: 'listening' }
  | { phase: 'checking' }
  | { phase: 'done'; text: string; matched: boolean; heard: string }
  | { phase: 'error'; message: string };

export interface OperatorDialogSession {
  manager_id: string;
  cli: string;
  session_id: string;
  cwd: string;
  title: string;
}

/**
 * operator 등록·수정(docs/voice-operator.md "Operator"). 이름은 부르는 말이라, 저장하기 전에 **불러 보게**
 * 한다: "헤이 <이름>" 을 실제 엔진으로 받아 적어 보고, 엔진이 이름을 다르게 적으면(`Jarvis` → `자비스`)
 * 그 철자를 별칭으로 더한다. 키워드 모델 학습 대신 이 한 번의 확인이 인식률을 정한다.
 */
export default function OperatorDialog({ open, onClose, operator, session, onSaved, onRemoved, onSendBrief }: {
  open: boolean;
  onClose: () => void;
  /** 고칠 operator — 없으면 `session` 을 새로 등록한다. */
  operator?: VoiceOperator | null;
  session?: OperatorDialogSession | null;
  /** 저장 뒤. `sendBrief` 는 새 등록에서 지침 보내기를 골랐는가. */
  onSaved?: (saved: VoiceOperator, opts: { sendBrief: boolean; created: boolean }) => void;
  /** 등록을 푼 뒤 — 세션은 그 장비에 그대로 남는다. */
  onRemoved?: () => void;
  /** 세션 화면에서만 — 지침을 다시 보낸다(이름을 바꿨거나, 긴 세션에서 지침이 흐려졌을 때). */
  onSendBrief?: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [sendBrief, setSendBrief] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  const testSessionRef = useRef<HandsFreeSession | null>(null);
  const releaseMicRef = useRef<(() => void) | null>(null);
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(operator?.name ?? '');
    setAliases((operator?.aliases ?? []).join(', '));
    setSendBrief(true);
    setConfirmRemove(false);
    setError(null);
    setTest({ phase: 'idle' });
  }, [open, operator]);

  const stopTest = useCallback(() => {
    if (testTimerRef.current) clearTimeout(testTimerRef.current);
    testTimerRef.current = null;
    const s = testSessionRef.current;
    testSessionRef.current = null;
    void s?.destroy();
    releaseMicRef.current?.();
    releaseMicRef.current = null;
  }, []);

  useEffect(() => { if (!open) stopTest(); }, [open, stopTest]);
  useEffect(() => stopTest, [stopTest]);

  const draft = { id: operator?.id ?? 'draft', name: name.trim(), aliases: parseAliasInput(aliases) };
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const runTest = useCallback(async () => {
    stopTest();
    setTest({ phase: 'listening' });
    // 불러 보는 동안 상시 청취를 쉬게 한다 — 이미 등록된 이름이면 그쪽이 깨어나 화면을 옮긴다.
    releaseMicRef.current = wakeStore.claimMic();
    try {
      const s = await startHandsFree({
        onUtterance: (wav) => {
          stopTest();
          setTest({ phase: 'checking' });
          api.transcribeVoice(wav)
            .then((t) => {
              const text = (t.text || '').trim();
              setTest({ phase: 'done', text, heard: heardName(text), matched: !!matchWake(text, [draftRef.current]) });
            })
            .catch((err: any) => setTest({ phase: 'error', message: err?.message || '받아 적지 못했습니다' }));
        },
      });
      testSessionRef.current = s;
      testTimerRef.current = setTimeout(() => {
        stopTest();
        setTest({ phase: 'error', message: '아무 말도 듣지 못했습니다 — 다시 눌러 "헤이 이름" 하고 불러 보세요.' });
      }, TEST_LISTEN_MS);
    } catch (err: any) {
      stopTest();
      setTest({ phase: 'error', message: err?.name === 'NotAllowedError' ? '마이크 권한이 없습니다.' : (err?.message || '마이크를 열지 못했습니다') });
    }
  }, [stopTest]);

  const addHeardAsAlias = (heard: string) => {
    const list = parseAliasInput(aliases);
    if (!list.includes(heard)) setAliases([...list, heard].join(', '));
    setTest((t) => (t.phase === 'done' ? { ...t, matched: true } : t));
  };

  const save = async () => {
    if (!draft.name) { setError('이름을 정해 주세요 — 부르는 말입니다.'); return; }
    setSaving(true);
    setError(null);
    try {
      const saved = operator
        ? (await api.updateVoiceOperator(operator.id, { name: draft.name, aliases: draft.aliases })).operator
        : session
          ? (await api.createVoiceOperator({ ...session, name: draft.name, aliases: draft.aliases })).operator
          : null;
      if (!saved) return;
      announceOperatorsChanged();
      onSaved?.(saved, { sendBrief: !operator && sendBrief, created: !operator });
      onClose();
    } catch (err: any) {
      setError(err?.message || '저장하지 못했습니다');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!operator) return;
    if (!confirmRemove) { setConfirmRemove(true); return; }
    setSaving(true);
    try {
      await api.deleteVoiceOperator(operator.id);
      announceOperatorsChanged();
      onRemoved?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || '해제하지 못했습니다');
    } finally {
      setSaving(false);
    }
  };

  const testLabel = test.phase === 'listening' ? '듣는 중… "헤이 이름" 하고 불러 보세요'
    : test.phase === 'checking' ? '받아 적는 중…'
      : '🎙 불러 보기';

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={operator ? `Operator — ${operator.name}` : '이 세션을 Operator 로 등록'}
      maxWidth={520}
      footer={(
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {operator && (
            <Button variant={confirmRemove ? 'danger' : 'ghost'} size="sm" onClick={() => void remove()} disabled={saving} style={{ marginRight: 'auto' }}>
              {confirmRemove ? '정말 해제' : '해제'}
            </Button>
          )}
          {operator && onSendBrief && (
            <Button variant="ghost" size="sm" onClick={() => { onSendBrief(operator.name); onClose(); }} title="operator 지침을 이 세션의 다음 프롬프트로 다시 보냅니다">
              지침 다시 보내기
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={onClose}>취소</Button>
          <Button variant="primary" size="sm" onClick={() => void save()} loading={saving} disabled={!draft.name}>
            {operator ? '저장' : sendBrief ? '등록하고 지침 보내기' : '등록'}
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, color: tokens.colors.textSecondary }}>
        <div>
          이름을 부르면 깨어납니다 — <b>"헤이 {draft.name || '이름'}"</b>, <b>"{withVocative(draft.name || '이름')}"</b>. 깨어난 뒤에는 이름 없이
          이어서 말하면 되고, 대화를 마치는 말을 하면 operator 가 알아듣고 다시 잠듭니다.
        </div>
        <Input label="이름" aria-label="Operator name" value={name} maxLength={32} placeholder="예: 자비스" onChange={(e) => setName(e.target.value)} autoFocus />
        <Input
          label="별칭 (쉼표로 구분)"
          aria-label="Operator aliases"
          value={aliases}
          placeholder="음성 인식이 이름을 다르게 적을 때 — 예: Jarvis, 쟈비스"
          onChange={(e) => setAliases(e.target.value)}
        />
        {voiceRecordingSupported() && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Button variant="secondary" size="sm" onClick={() => void runTest()} disabled={!draft.name || test.phase === 'listening' || test.phase === 'checking'}>
                {testLabel}
              </Button>
              <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>엔진이 이름을 어떻게 적는지 확인합니다</span>
            </div>
            {test.phase === 'done' && (
              <div role="status" style={{ fontSize: 12, padding: '6px 10px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}` }}>
                들은 말: <i>{test.text || '(없음)'}</i>
                <div style={{ marginTop: 4, color: test.matched ? tokens.colors.successLight : tokens.colors.warningLight }}>
                  {test.matched ? '✓ 이 이름으로 깨어납니다.' : '이 말로는 깨어나지 않습니다.'}
                  {!test.matched && test.heard && (
                    <Button variant="ghost" size="sm" onClick={() => addHeardAsAlias(test.heard)} style={{ marginLeft: 6 }}>
                      "{test.heard}" 를 별칭으로 추가
                    </Button>
                  )}
                </div>
              </div>
            )}
            {test.phase === 'error' && <div role="status" style={{ fontSize: 12, color: tokens.colors.warningLight }}>{test.message}</div>}
          </div>
        )}
        {!operator && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={sendBrief} onChange={(e) => setSendBrief(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              operator 지침을 이 세션의 다음 프롬프트로 보냅니다 — 말로 듣기 좋은 답, 되돌리기 어려운 일의 복창 확인,
              대화를 마칠 때 잠드는 규칙.
            </span>
          </label>
        )}
        {error && <div role="alert" style={{ color: tokens.colors.dangerLight, fontSize: 12 }}>{error}</div>}
      </div>
    </Modal>
  );
}
