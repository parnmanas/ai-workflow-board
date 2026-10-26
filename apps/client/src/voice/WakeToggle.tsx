import { t as translate } from '../i18n/core';
import { useLocale } from '../i18n/react';
import { tokens } from '../tokens';
import type { VoiceOperator } from '../types';
import { speechPlayer } from './speechPlayer';
import { useVoiceConfig } from './useVoice';
import { useWakeState, wakeStore, type WakeSnapshot } from './wakeState';

/** 지금 상태를 한 줄로 — 버튼의 툴팁과 스크린 리더가 읽는다. */
export function describeWake(state: WakeSnapshot, operators: readonly VoiceOperator[], unavailable: string | null, reportOperatorId?: string | null): string {
  if (unavailable) return unavailable;
  if (state.mode === 'awake') {
    const name = operators.find((op) => op.id === state.operatorId)?.name || 'operator';
    return translate('{0} 깨어 있음 — 이름 없이 말하면 됩니다', { 0: name });
  }
  const names = operators.map((op) => translate('"헤이 {0}"', { 0: op.name })).join(', ');
  const answering = state.followUp ? operators.find((op) => op.id === state.followUp!.operatorId) : null;
  if (answering) {
    if (state.listener === 'error') return translate('음성 입력 오류: {0}', { 0: state.error || translate('마이크를 열지 못했습니다') });
    if (state.listener === 'other-tab') return translate('다른 탭에서 {0}에게 듣고 있습니다', { 0: answering.name });
    if (state.listener === 'starting') return translate('{0}의 마이크 여는 중…', { 0: answering.name });
    if (state.listener === 'waiting-gesture') return translate('화면을 한 번 누르면 알림을 보낸 operator에게 듣기 시작합니다');
    return translate('{0}에게 듣는 중 — 이름 없이 "보고해"라고 말하세요', { 0: answering.name });
  }
  const reporting = operators.find((op) => op.id === reportOperatorId);
  if (!state.enabled) return reporting ? translate('마이크 꺼짐 — 누르면 "보고해"로 {0}의 알림 내용을 들을 수 있습니다', { 0: reporting.name })
    : translate('음성 지원 꺼짐 — 누르면 켜집니다 ("헤이 <이름>" 듣기 + 답 낭독). 꺼져 있으면 세션 완료 소식도 operator 에게 가지 않습니다(다른 단말이 켜져 있으면 갑니다)');
  switch (state.listener) {
    case 'waiting-gesture': return translate('화면을 한 번 누르면 듣기 시작합니다(브라우저가 사용자 동작 전에는 마이크 소리를 막습니다)');
    case 'other-tab': return translate('다른 탭이 듣고 있습니다');
    case 'starting': return translate('마이크 여는 중…');
    case 'checking': return translate('들은 말이 이름인지 확인하는 중…');
    case 'error': return translate('음성 지원 오류: {0}', { 0: state.error || translate('알 수 없음') });
    case 'listening': return translate('듣는 중 — {0}{1}', { 0: names, 1: reporting ? translate(' 또는 "보고해" ({0})', { 0: reporting.name }) : '' });
    default: return state.micClaims > 0 ? translate('대화 모드가 마이크를 쓰는 동안 쉽니다') : translate('켜짐 — {0}', { 0: names });
  }
}

/**
 * 음성 지원 켜기/끄기(사이드바 OPERATORS 머리). 단말마다 따로 켠다 — 상시 청취는 그 단말의 마이크다.
 * 꺼져 있으면 듣지도 읽지도 않는다(알림 TTS·세션 종료 낭독 건너뜀). 사용자의 단말이 모두 꺼져 있으면 서버가
 * 세션 완료·오류를 operator 에게 보고하지도 않는다(`wakeStore.setEnabled` → `PUT /api/voice/support`).
 * 누르는 동작이 사용자 제스처라, 나중에 제스처 없이 낼 소리(답 낭독)를 여기서 깨워 둔다.
 */
export default function WakeToggle({ operators }: { operators: readonly VoiceOperator[] }) {
  useLocale();
  const config = useVoiceConfig();
  const state = useWakeState();
  const unavailable = !config ? translate('음성 설정을 읽는 중…')
    : !config.wake.ready ? (config.wake.error || translate('음성 인식이 준비되지 않았습니다{0}', { 0: config.stt.error ? ` — ${config.stt.error}` : '' }))
      : null;
  const label = describeWake(state, operators, unavailable, wakeStore.reportOperator());
  const on = (state.enabled || !!state.followUp || state.mode === 'awake') && !unavailable;
  const color = !on ? tokens.colors.textMuted
    : state.mode === 'awake' ? tokens.colors.successLight
      : state.listener === 'error' ? tokens.colors.warningLight
        : state.listener === 'listening' || state.listener === 'checking' ? tokens.colors.accentSubtle
          : tokens.colors.textSecondary;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      data-wake-listener={on ? (state.mode === 'awake' ? 'awake' : state.listener) : 'off'}
      disabled={!!unavailable && !state.enabled}
      onClick={() => {
        const next = !on;
        if (next) speechPlayer.unlock();
        wakeStore.setEnabled(next);
      }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 7px', borderRadius: 999,
        border: `1px solid ${on ? color : tokens.colors.border}`, background: 'transparent', color,
        cursor: unavailable && !state.enabled ? 'not-allowed' : 'pointer', fontSize: 10, fontWeight: 700,
        letterSpacing: '0.04em', textTransform: 'none', opacity: unavailable && !state.enabled ? 0.55 : 1,
      }}
    >
      <span aria-hidden="true">{state.mode === 'awake' && on ? '●' : state.listener === 'error' && on ? '!' : '👂'}</span>
      {on ? (state.mode === 'awake' ? translate('awake') : state.listener === 'error' ? translate('error') : state.listener === 'starting' ? translate('starting')
        : state.listener === 'waiting-gesture' ? translate('tap') : state.followUp ? translate('listen') : translate('on')) : translate('off')}
    </button>
  );
}
