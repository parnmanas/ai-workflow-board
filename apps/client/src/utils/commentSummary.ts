export function isCommentSummaryInProgress(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'completing';
}
