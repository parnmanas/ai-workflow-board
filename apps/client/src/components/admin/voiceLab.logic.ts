/**
 * Voice lab(엔진 고르기)의 순수 로직. 품질이 기준이므로 숫자(CER)와 귀(블라인드 평점)를 둘 다 남긴다
 * — docs/voice-operator.md "선정 절차".
 */

/** 비교용 정규화: 대소문자·공백·문장부호를 지운다. 한국어 CER 은 띄어쓰기를 세지 않는 것이 관례다. */
export function normalizeForCer(text: string): string {
  return (text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 문자 오류율 = 편집 거리 / 정답 길이. 정답이 비어 있으면 null(잴 수 없다).
 * 영어 용어를 한글로 옮겨 적은 것("에이전트 매니저")도 오류로 센다 — 실제로 프롬프트에서 다르게 읽힌다.
 */
export function characterErrorRate(reference: string, hypothesis: string): number | null {
  const ref = [...normalizeForCer(reference)];
  const hyp = [...normalizeForCer(hypothesis)];
  if (ref.length === 0) return null;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[hyp.length] / ref.length;
}

export interface TtsCandidate {
  key: string;
  provider: string;
  voice: string;
  model: string;
}

export interface BlindClip {
  sentenceIndex: number;
  /** 화면에 보이는 이름(A, B, …). 문장마다 다시 섞는다 — 순서로 공급자를 짐작하지 못하게. */
  label: string;
  candidateKey: string;
  url: string | null;
  latencyMs: number | null;
  error: string | null;
  rating: number | null;
}

/** 0 이상 1 미만 난수. 테스트가 고정 시드를 넣는다. */
export type Random = () => number;

export function shuffled<T>(items: T[], random: Random = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function clipLabel(index: number): string {
  return String.fromCharCode(65 + (index % 26)) + (index >= 26 ? String(Math.floor(index / 26)) : '');
}

/** 문장 × 후보 → 문장마다 섞어 이름 붙인 빈 클립들(소리는 아직 없다). */
export function planBlindClips(sentenceCount: number, candidates: TtsCandidate[], random: Random = Math.random): BlindClip[] {
  const clips: BlindClip[] = [];
  for (let s = 0; s < sentenceCount; s++) {
    shuffled(candidates, random).forEach((c, i) => {
      clips.push({ sentenceIndex: s, label: clipLabel(i), candidateKey: c.key, url: null, latencyMs: null, error: null, rating: null });
    });
  }
  return clips;
}

export interface CandidateSummary {
  candidateKey: string;
  rated: number;
  averageRating: number | null;
  averageLatencyMs: number | null;
  failures: number;
}

export function summarizeBlindTest(clips: BlindClip[], candidates: TtsCandidate[]): CandidateSummary[] {
  return candidates
    .map((c) => {
      const mine = clips.filter((clip) => clip.candidateKey === c.key);
      const ratings = mine.map((clip) => clip.rating).filter((r): r is number => typeof r === 'number');
      const latencies = mine.map((clip) => clip.latencyMs).filter((l): l is number => typeof l === 'number');
      const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      return {
        candidateKey: c.key,
        rated: ratings.length,
        averageRating: avg(ratings),
        averageLatencyMs: avg(latencies),
        failures: mine.filter((clip) => clip.error).length,
      };
    })
    .sort((a, b) => (b.averageRating ?? -1) - (a.averageRating ?? -1));
}

/** 블라인드 테스트 기본 문장 — 실제로 들을 말투(작업 보고)와 섞어 쓰는 영어 용어·호스트 이름·숫자를 담는다. */
export const DEFAULT_BLIND_SENTENCES = [
  '롤프의 Claude 세션 작업이 끝났어요. 테스트 280개 중 280개가 통과했습니다.',
  '미션 "음성 게이트웨이"에서 확인이 필요해요. PR을 main에 머지할까요?',
  'ragnar의 vLLM이 GPU 메모리를 60기가 쓰고 있어서, 새 모델은 랄프에 올리는 게 좋겠습니다.',
  'agent-manager를 1.6.240으로 업데이트했고, 세 호스트 모두 다시 연결됐습니다.',
  '오늘 오후 3시 반에 배포했고, 에러율은 0.2퍼센트에서 0.05퍼센트로 떨어졌어요.',
].join('\n');
