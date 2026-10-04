/**
 * 이름 부르기(웨이크워드)와 잠들기의 순수 규칙 — docs/voice-operator.md "이름 부르기 · 잠들기".
 *
 * 깨우는 말은 키워드 모델이 아니라 **글자로** 확인한다: 잠든 동안 들린 발화마다 자체 호스팅 STT 로
 * 받아 적고, 그 글이 "헤이 <이름>" 으로 시작하는지 본다. 이름을 마음대로 지을 수 있어야 해서다 —
 * 키워드 모델은 이름마다 따로 학습해야 한다.
 *
 * 음성 인식은 이름을 조금씩 틀리게 적는다("자비스" → "재비스" · "잡이스", "Jarvis" → "Javis"). 그래서
 *   - 대소문자·공백·문장부호를 무시하고(`compactKey`, 서버 `operatorNameKey` 와 같은 규칙),
 *   - 한글은 소리 나는 대로 자모로 풀어 편집 거리를 재며(연음 "잡이스" = "자비스", 모음 하나 차이는 1),
 *   - 이름 길이에 비례하는 만큼만 틀려도 같은 이름으로 본다.
 * 철자가 아예 다르게 나오는 이름(`Jarvis` 를 `자비스` 로)은 operator 의 별칭으로 등록한다.
 */

/** 부르는 말 앞머리. 음성 인식이 "헤이" 를 다르게 적는 경우까지 둔다. */
export const WAKE_PREFIXES = [
  'hey', 'hi', 'hello', 'ok', 'okay',
  '헤이', '해이', '헤에', '에이', '하이', '헬로', '오케이', '야',
];

/** 이름 뒤에 붙는 부름 조사 — "자비스야", "민준아". */
const VOCATIVES = ['야', '아'];

interface Compacted {
  /** 글자·숫자만 남긴 소문자 문자열. */
  chars: string;
  /** chars 의 i 번째 글자가 원문(NFC)에서 시작하는 위치. */
  start: number[];
  /** chars 의 i 번째 글자가 원문(NFC)에서 끝나는 위치(다음 글자의 시작이 아니라 이 글자의 끝). */
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

/** 이름 비교 키 — 서버 `operator-config.ts` `operatorNameKey` 와 같은 규칙. */
export function compactKey(value: string): string {
  return compact(value.normalize('NFC')).chars;
}

const PREFIX_KEYS = [...new Set(WAKE_PREFIXES.map(compactKey))].sort((a, b) => b.length - a.length);

// 음절을 **소리 나는 대로** 자모로 푼다. 엔진은 같은 소리를 다르게 적는다 — "자비스" 를 "잡이스" 로(연음).
// 그래서 받침과 초성을 같은 자음으로 쓰고, 소리 없는 초성 ㅇ 은 뺀다(잡이스 → ㅈㅏㅂㅣㅅㅡ = 자비스).
// 겹받침은 두 자음으로 풀고, 요즘 발음에서 구별되지 않는 모음(ㅐ/ㅔ, ㅒ/ㅖ, ㅙ/ㅚ/ㅞ)은 하나로 본다.
const CHOSEONG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', '', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const JUNGSEONG = ['ㅏ', 'ㅔ', 'ㅑ', 'ㅖ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅞ', 'ㅞ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const JONGSEONG = ['', 'ㄱ', 'ㄲ', 'ㄱㅅ', 'ㄴ', 'ㄴㅈ', 'ㄴㅎ', 'ㄷ', 'ㄹ', 'ㄹㄱ', 'ㄹㅁ', 'ㄹㅂ', 'ㄹㅅ', 'ㄹㅌ', 'ㄹㅍ', 'ㄹㅎ', 'ㅁ', 'ㅂ', 'ㅂㅅ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

/** 한글 음절 → 소리 나는 대로의 자모(위 규칙). 그 밖의 글자는 그대로. */
export function toJamo(value: string): string {
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

export function editDistance(a: string, b: string): number {
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

/** 이름(자모 길이)에 따라 봐줄 틀림. 짧은 이름일수록 엄격하다 — 짧은 말은 우연히 겹치기 쉽다. */
export function wakeTolerance(jamoLength: number): number {
  if (jamoLength <= 3) return 0;
  if (jamoLength <= 6) return 1;
  if (jamoLength <= 10) return 2;
  return 3;
}

export interface WakeCandidate {
  id: string;
  name: string;
  aliases: string[];
}

export interface WakeMatch<T extends WakeCandidate = WakeCandidate> {
  operator: T;
  /** 이름으로 들린 부분(원문 그대로) — 별칭 등록을 돕는다. */
  heard: string;
  /** 부르는 말 뒤에 이어서 한 말 — 깨어나자마자 보낼 첫 요청. 없으면 ''. */
  rest: string;
  distance: number;
  /** 어떻게 불렀나 — 앞머리("헤이 …") · 부름 조사("…야"). */
  form: 'prefix' | 'vocative';
}

/**
 * 들린 글이 operator 를 부르는 말인가. 부르는 말은 발화의 **맨 앞**에 있어야 한다:
 *   - "헤이 자비스 …", "Hey Jarvis, …", "오케이 자비스 …"   — 앞머리 + 이름
 *   - "자비스야 …", "민준아 …"                           — 이름 + 부름 조사
 * 이름은 낱말 경계에서 끝나야 한다("헤이 자비스트" 는 아니다). 가장 가깝게 맞은 operator 를 고른다.
 *
 * **이름만 한 발화("자비스?")는 부름으로 보지 않는다.** 엔진은 짧은 잡음에 대해 문맥으로 준 용어집(이름이
 * 들어 있다)을 그대로 읊기도 한다(실측: "자비스, Jarvis.") — 이름 단독을 받으면 잠든 동안 기침 한 번에
 * 깨어난다. 앞머리나 부름 조사는 엔진이 지어내지 않는다(문맥에 없다).
 */
export function matchWake<T extends WakeCandidate>(text: string, operators: readonly T[]): WakeMatch<T> | null {
  const norm = (text || '').normalize('NFC');
  const c = compact(norm);
  if (!c.chars) return null;
  // 원문에서 i 번째 글자 다음에 구분(공백·문장부호)이 오는가 — 끝이면 참.
  const boundaryAfter = (i: number) => i + 1 >= c.chars.length || /[\s\p{P}\p{S}]/u.test(norm.slice(c.end[i], c.start[i + 1]));
  const starts = PREFIX_KEYS.filter((p) => c.chars.startsWith(p) && c.chars.length > p.length).map((p) => ({ at: p.length, prefixed: true }));
  starts.push({ at: 0, prefixed: false });

  let best: (WakeMatch<T> & { score: number }) | null = null;
  for (const operator of operators) {
    for (const name of [operator.name, ...operator.aliases]) {
      const key = compactKey(name);
      if (!key) continue;
      const keyJamo = toJamo(key);
      const tolerance = wakeTolerance(keyJamo.length);
      for (const { at, prefixed } of starts) {
        for (let k = Math.max(1, key.length - 1); k <= key.length + 1 && at + k <= c.chars.length; k++) {
          const distance = editDistance(toJamo(c.chars.slice(at, at + k)), keyJamo);
          if (distance > tolerance) continue;
          const last = at + k - 1;
          const vocative = last + 1 < c.chars.length && VOCATIVES.includes(c.chars[last + 1]) && boundaryAfter(last + 1);
          const endsWord = boundaryAfter(last);
          if (!endsWord && !vocative) continue;
          const tail = vocative ? last + 1 : last;
          if (!prefixed && !vocative) continue; // 문장 첫머리의 이름은 이야기이거나 엔진의 메아리다
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

/** 부름 조사를 붙인 이름 — 받침으로 끝나면 "아"(민준아), 아니면 "야"(자비스야). 한글이 아닌 이름은 "야". */
export function withVocative(name: string): string {
  const last = name.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  return `${name.trim()}${code >= 0 && code < 11172 && code % 28 ? '아' : '야'}`;
}

/**
 * 이름을 시험 삼아 불렀을 때 엔진이 이름을 어떻게 적었는가 — 앞머리를 떼고 남은 말. 철자가 다르게
 * 나오면 그것을 별칭으로 등록한다.
 */
export function heardName(text: string): string {
  const norm = (text || '').normalize('NFC');
  const c = compact(norm);
  const prefix = PREFIX_KEYS.find((p) => c.chars.startsWith(p) && c.chars.length > p.length);
  const from = prefix ? c.start[prefix.length] : 0;
  return norm.slice(from).replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '').slice(0, 32);
}

// ─── 잠들기 ──────────────────────────────────────────────────────────────

/**
 * operator 가 대화를 마무리한다고 판단하면 답 끝에 붙이는 표시. 문맥으로 끝을 알아보는 것은 대화를
 * 이해하는 operator 의 몫이다 — 화면은 "고마워" 같은 낱말로 추측하지 않는다("고마워, 그리고 하나 더"
 * 를 끝으로 읽으면 안 된다). 서버의 낭독 정리(`speakable.ts` `SLEEP_MARKER_RE`)도 같은 표시를 지운다.
 */
export const SLEEP_MARKER = '[[sleep]]';
const SLEEP_MARKER_RE = /\[\[\s*sleep\s*\]\]/gi;

export function splitSleepMarker(answer: string): { text: string; sleep: boolean } {
  const sleep = SLEEP_MARKER_RE.test(answer || '');
  SLEEP_MARKER_RE.lastIndex = 0;
  return { text: sleep ? answer.replace(SLEEP_MARKER_RE, '').trim() : answer || '', sleep };
}

/** 깨어난 뒤 처음 보내는 요청 앞에 붙는 한 줄 — 긴 세션에서 지침이 요약돼 사라져도 규칙이 남게. */
export const WAKE_PROMPT_NOTE = `(음성 대화 — 사용자가 대화를 마치는 말을 하면 짧게 인사하고 답 맨 끝에 ${SLEEP_MARKER} 를 붙이세요.)`;

export function withWakeNote(text: string): string {
  return `${WAKE_PROMPT_NOTE}\n${text}`;
}

/** 화면에 보일 때는 그 한 줄을 떼고 "음성" 표시로 대신한다. */
export function stripWakeNote(text: string): { text: string; noted: boolean } {
  if (!text.startsWith(WAKE_PROMPT_NOTE)) return { text, noted: false };
  return { text: text.slice(WAKE_PROMPT_NOTE.length).replace(/^\n/, ''), noted: true };
}

/** 깨어 있는 동안 들린 군소리 — 프롬프트로 보내지 않는다. "네" 는 확인 대답이라 군소리가 아니다. */
const FILLERS = new Set(['음', '음음', '으음', '어', '어어', '흠', '으', '아', 'um', 'uh', 'hmm', 'mm', 'eh']);

export function isFillerUtterance(text: string): boolean {
  const key = compactKey(text || '');
  return !key || FILLERS.has(key);
}

/** 깨어 있다가 아무 말이 없으면 이만큼 뒤에 잠든다(답을 기다리거나 읽는 동안은 세지 않는다). */
export const WAKE_IDLE_SLEEP_MS = 60_000;
