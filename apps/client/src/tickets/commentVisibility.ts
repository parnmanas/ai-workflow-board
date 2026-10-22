import type { Comment } from '../types';

type ConversationComment = Pick<Comment, 'author_type' | 'content' | 'metadata'>;

/** Failures are part of the conversation, even when routine system history is hidden. */
export function isRoutineSystemComment(comment: ConversationComment): boolean {
  return comment.author_type === 'system'
    && comment.metadata?.reason !== 'silent_exit'
    && !comment.content.trimStart().startsWith('⚠');
}

export function ticketExecutionFailure(comment: ConversationComment): { title: string; guidance: string } | null {
  if (comment.author_type !== 'system' || comment.metadata?.reason !== 'silent_exit') return null;
  // Existing manager versions put the classified reason in the metadata line
  // of the body. Read that line, not arbitrary quoted CLI output.
  const reasonLine = comment.content.split('\n').find(line => /^_.*exit_code=/.test(line)) || '';
  if (/\breason=auth_failure\b/.test(reasonLine)) {
    const usedRefreshToken = /refresh token was already used/i.test(comment.content);
    return {
      title: 'CLI 인증 실패로 실행이 중단되었습니다.',
      guidance: usedRefreshToken
        ? '이미 사용된 refresh token으로 로그인 갱신에 실패했습니다. 선택한 CLI credential을 다시 로그인해 갱신한 뒤 티켓을 재실행하세요.'
        : '선택한 CLI credential을 확인·갱신한 뒤 티켓을 재실행하세요.',
    };
  }
  return {
    title: '에이전트 실행이 종료되어 결과를 확인해야 합니다.',
    guidance: '실행 로그와 최근 작업 결과를 확인하세요. 티켓의 진행 상태만으로는 현재 실행 중인지 알 수 없습니다.',
  };
}
