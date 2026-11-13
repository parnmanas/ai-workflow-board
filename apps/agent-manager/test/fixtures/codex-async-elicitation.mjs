// codex-acp 2.6.0's AsyncQuestionElicitations emits this form in addition to
// Codex's rollout record. In particular it supplies NO question/call/request ID.
export const codexAsyncForm = {
  mode: 'form',
  message: 'Codex keeps working while you answer. An answer sent after it finishes is not delivered.',
  requestedSchema: {
    type: 'object',
    properties: {
      question_0: {
        title: '요약 방식?', type: 'string', _meta: { codex: { isOther: true, isSecret: false } },
        oneOf: [
          ...['짧게', '자세히'].map(value => ({ const: value, title: value })),
          { const: 'None of the above', title: 'None of the above', description: 'Provide a different answer in the note field.' },
        ],
      },
      question_0_note: {
        title: 'Additional answer or note', type: 'string',
        _meta: { codex: { questionId: 'question_0', role: 'user_note', isSecret: false } },
      },
    },
  },
  _meta: { codex: { delivery: 'async' } },
};

export const codexAsyncRecord = (id) => ({ type: 'event_msg', payload: { type: 'item_completed', item: {
  type: 'AgentMessage', id, delivery: 'async',
  content: [{ type: 'Text', text: '요약 방식?\n- 짧게\n- 자세히' }],
  questions: [{ title: '요약 방식?', options: ['짧게', '자세히'] }],
} } });
