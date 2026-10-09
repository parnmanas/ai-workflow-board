import type { OperatorEntry } from './operator-config';

/**
 * 이름 부르기(웨이크워드) 판정 — 서버 측 포트.
 *
 * 원본은 `apps/client/src/voice/wake.logic.ts` `matchWake` 다. Android 백그라운드 wake
 * (네이티브 포그라운드 서비스)가 STT 글자를 받아 "누구를 불렀는가"를 물을 때 쓴다
 * (`POST /api/voice/operators/match`). 세 runtime(웹 탭 상시청취·서버 매치·향후 iOS)이
 * 같은 말을 같은 operator 로 알아들어야 하므로 규칙을 고치면 **원본과 여기를 함께**
 * 고칠 것 — 서버 테스트 `voice-wake-match.test.mjs` 와 화면 테스트 `voice-wake.test.mjs`
 * 가 같은 케이스를 양쪽에서 단언한다.
 */

export const WAKE_PREFIXES = [
  'hey', 'hi', 'hello', 'ok', 'okay',
  '헤이', '해이', '헤에', '에이', '하이', '헬로', '오케이', '야',
];

const VOCATIVES = ['야', '아'];

interface Compacted {
  chars: string;
  start: number[];
  end: number[];
}

const SEPARATOR_RE = /[\s\p{P}\p{S}]/u;

function compact(norm: string): Compacted {
  let chars = '';
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < norm.length;) {
    const ch = String.fromCodePoint(norm.codePointAt(i)!);
    const next = i + ch.length;
    if (!SEPARATOR_RE.test(ch)) {
      for (const unit of ch.toLowerCase()) {
        chars += unit;
        start.push(i);
        end.push(next);
      }
    }
    i = next;
  }
  return { chars, start, end };
}

export function wakeCompactKey(value: string): string {
  return compact(value.normalize('NFC')).chars;
}

const PREFIX_KEYS = [...new Set(WAKE_PREFIXES.map(wakeCompactKey))].sort((a, b) => b.length - a.length);

const CHOSEONG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', '', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const JUNGSEONG = ['ㅏ', 'ㅔ', 'ㅑ', 'ㅖ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅞ', 'ㅞ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const JONGSEONG = ['', 'ㄱ', 'ㄲ', 'ㄱㅅ', 'ㄴ', 'ㄴㅈ', 'ㄴㅎ', 'ㄷ', 'ㄹ', 'ㄹㄱ', 'ㄹㅁ', 'ㄹㅂ', 'ㄹㅅ', 'ㄹㅌ', 'ㄹㅍ', 'ㄹㅎ', 'ㅁ', 'ㅂ', 'ㅂㅅ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

export function wakeToJamo(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code >= 0 && code < 11172) {
      out += CHOSEONG[Math.floor(code / 588)] + JUNGSEONG[Math.floor((code % 588) / 28)] + JONGSEONG[code % 28];
    } else {
      out += ch;
    }
  }
  return out;
}

export function wakeEditDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

export function wakeTolerance(jamoLength: number): number {
  if (jamoLength <= 3) return 0;
  if (jamoLength <= 6) return 1;
  if (jamoLength <= 10) return 2;
  return 3;
}

export interface WakeMatchResult {
  operator: OperatorEntry;
  heard: string;
  rest: string;
  distance: number;
  form: 'prefix' | 'vocative';
}

export function matchWakeOperator<T extends { name: string; aliases: string[] }>(
  text: string,
  operators: readonly T[],
): (Omit<WakeMatchResult, 'operator'> & { operator: T }) | null {
  const norm = (text || '').normalize('NFC');
  const c = compact(norm);
  if (!c.chars) return null;
  const boundaryAfter = (i: number) => i + 1 >= c.chars.length || /[\s\p{P}\p{S}]/u.test(norm.slice(c.end[i], c.start[i + 1]));
  const starts = PREFIX_KEYS.filter((p) => c.chars.startsWith(p) && c.chars.length > p.length).map((p) => ({ at: p.length, prefixed: true }));
  starts.push({ at: 0, prefixed: false });

  let best: (Omit<WakeMatchResult, 'operator'> & { operator: T; score: number }) | null = null;
  for (const operator of operators) {
    for (const name of [operator.name, ...operator.aliases]) {
      const key = wakeCompactKey(name);
      if (!key) continue;
      const keyJamo = wakeToJamo(key);
      const tolerance = wakeTolerance(keyJamo.length);
      for (const { at, prefixed } of starts) {
        for (let k = Math.max(1, key.length - 1); k <= key.length + 1 && at + k <= c.chars.length; k++) {
          const distance = wakeEditDistance(wakeToJamo(c.chars.slice(at, at + k)), keyJamo);
          if (distance > tolerance) continue;
          const last = at + k - 1;
          const vocative = last + 1 < c.chars.length && VOCATIVES.includes(c.chars[last + 1]) && boundaryAfter(last + 1);
          const endsWord = boundaryAfter(last);
          if (!endsWord && !vocative) continue;
          const tail = vocative ? last + 1 : last;
          if (!prefixed && !vocative) continue;
          const score = distance + (prefixed ? 0 : 0.5) - k * 0.001;
          if (best && best.score <= score) continue;
          best = {
            operator,
            heard: norm.slice(c.start[at], c.end[last]),
            rest: norm.slice(c.end[tail]).replace(/^[\s,.!?~…:;·\-]+/u, '').trim(),
            distance,
            form: prefixed ? 'prefix' : 'vocative',
            score,
          };
        }
      }
    }
  }
  if (!best) return null;
  const { score: _score, ...match } = best;
  return match;
}

/** 네이티브 백그라운드 wake 응답 모양 — 세션으로 가는 데 필요한 것만 내보낸다. */
export function toWakeMatchResponse(match: WakeMatchResult | null): {
  operator: Pick<OperatorEntry, 'id' | 'name' | 'manager_id' | 'cli' | 'session_id'> | null;
  heard: string;
  rest: string;
  distance: number;
  form: 'prefix' | 'vocative' | null;
} {
  if (!match) return { operator: null, heard: '', rest: '', distance: -1, form: null };
  const { id, name, manager_id, cli, session_id } = match.operator;
  return { operator: { id, name, manager_id, cli, session_id }, heard: match.heard, rest: match.rest, distance: match.distance, form: match.form };
}
