/** 같은 comment의 공동 role holder를 서로 다른 실행으로 식별한다. */
export function mentionTriggerId(commentId: string, agentId?: string): string {
  return `mention:${commentId}:${agentId || ''}`;
}
