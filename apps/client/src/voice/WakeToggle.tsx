import { tokens } from '../tokens';
import type { VoiceOperator } from '../types';
import { speechPlayer } from './speechPlayer';
import { useVoiceConfig } from './useVoice';
import { useWakeState, wakeStore, type WakeSnapshot } from './wakeState';

/** 지금 상태를 한 줄로 — 버튼의 툴팁과 스크린 리더가 읽는다. */
export function describeWake(state: WakeSnapshot, operators: readonly VoiceOperator[], unavailable: string | null): string {
  if (unavailable) return unavailable;
  if (!state.enabled) return '이름 부르기 꺼짐 — 누르면 "헤이 <이름>" 을 듣기 시작합니다';
  if (state.mode === 'awake') {
    const name = operators.find((op) => op.id === state.operatorId)?.name || 'operator';
    return `${name} 깨어 있음 — 이름 없이 말하면 됩니다`;
  }
  const names = operators.map((op) => `"헤이 ${op.name}"`).join(', ');
  const answering = state.followUp ? operators.find((op) => op.id === state.followUp!.operatorId) : null;
  if (answering) return `${answering.name} 에게 답을 듣는 중 — 이름 없이 바로 말하세요`;
  switch (state.listener) {
    case 'waiting-gesture': return '화면을 한 번 누르면 듣기 시작합니다(브라우저가 사용자 동작 전에는 마이크 소리를 막습니다)';
    case 'other-tab': return '다른 탭이 듣고 있습니다';
    case 'starting': return '마이크 여는 중…';
    case 'checking': return '들은 말이 이름인지 확인하는 중…';
    case 'error': return `이름 부르기 오류: ${state.error || '알 수 없음'}`;
    case 'listening': return `듣는 중 — ${names}`;
    default: return state.micClaims > 0 ? '대화 모드가 마이크를 쓰는 동안 쉽니다' : `켜짐 — ${names}`;
  }
}

/**
 * 이름 부르기 켜기/끄기(사이드바 OPERATORS 머리). 단말마다 따로 켠다 — 상시 청취는 그 단말의 마이크다.
 * 누르는 동작이 사용자 제스처라, 나중에 제스처 없이 낼 소리(답 낭독)를 여기서 깨워 둔다.
 */
export default function WakeToggle({ operators }: { operators: readonly VoiceOperator[] }) {
  const config = useVoiceConfig();
  const state = useWakeState();
  const unavailable = !config ? '음성 설정을 읽는 중…'
    : !config.wake.ready ? (config.wake.error || `음성 인식이 준비되지 않았습니다${config.stt.error ? ` — ${config.stt.error}` : ''}`)
      : null;
  const label = describeWake(state, operators, unavailable);
  const on = state.enabled && !unavailable;
  const color = !on ? tokens.colors.textMuted
    : state.mode === 'awake' ? tokens.colors.successLight
      : state.listener === 'error' ? tokens.colors.warningLight
        : state.listener === 'listening' || state.listener === 'checking' ? tokens.colors.accentSubtle
          : tokens.colors.textSecondary;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={state.enabled}
      aria-label={label}
      title={label}
      data-wake-listener={on ? (state.mode === 'awake' ? 'awake' : state.listener) : 'off'}
      disabled={!!unavailable && !state.enabled}
      onClick={() => {
        const next = !state.enabled;
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
      {on ? (state.mode === 'awake' ? 'awake' : state.followUp ? 'answer' : state.listener === 'waiting-gesture' ? 'tap' : 'on') : 'off'}
    </button>
  );
}
