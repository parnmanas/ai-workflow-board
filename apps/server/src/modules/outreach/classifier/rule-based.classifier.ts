import { InboundItem } from '../connectors/types';
import { ClassificationResult, OutreachClassifier } from './types';

const BUG_KEYWORDS = [
  'bug', 'crash', 'broken', 'error', 'exception', 'regression', 'not working', "doesn't work",
  '버그', '오류', '에러', '깨짐', '안 됨', '안됨', '고장',
];
const FEATURE_KEYWORDS = [
  'feature request', 'feature', 'enhancement', 'would be nice', 'please add', 'suggestion',
  '기능 추가', '건의', '제안', '추가해', '지원해',
];
const QUESTION_KEYWORDS = [
  'how do i', 'how to', 'question', 'is it possible', 'could you explain',
  '질문', '어떻게', '가능한가요', '궁금',
];

/**
 * Deterministic keyword-based OutreachClassifier — the fake this ticket ships
 * (see types.ts docstring for why a real LLM classifier is a follow-up).
 *
 * Precedence when multiple keyword sets match: bug > feature_request >
 * question — a bug report phrased as a question ("왜 자꾸 crash 하나요?") should
 * still file as a bug, not a question. Confidence is fixed per category (not
 * content-scaled) since this is a placeholder, not a scored model — real
 * per-item confidence arrives with the real classifier.
 */
export class RuleBasedClassifier implements OutreachClassifier {
  async classify(item: InboundItem): Promise<ClassificationResult> {
    const text = `${item.title}\n${item.body}`.toLowerCase();
    if (BUG_KEYWORDS.some((kw) => text.includes(kw))) {
      return { category: 'bug', confidence: 85 };
    }
    if (FEATURE_KEYWORDS.some((kw) => text.includes(kw))) {
      return { category: 'feature_request', confidence: 80 };
    }
    if (QUESTION_KEYWORDS.some((kw) => text.includes(kw)) || text.trim().endsWith('?')) {
      return { category: 'question', confidence: 75 };
    }
    return { category: 'noise', confidence: 60 };
  }
}
