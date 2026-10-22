/** Select the latest five comments, oldest first, without changing the REST snapshot. */
export function recentComments<T extends { created_at?: string }>(comments: readonly T[]): T[] {
  const timestamp = (comment: T): number => {
    const value = Date.parse(comment.created_at || '');
    // Undated comments precede dated progress rather than displacing the latest updates.
    return Number.isFinite(value) ? value : -Infinity;
  };
  return [...comments].sort((a, b) => timestamp(a) - timestamp(b)).slice(-5);
}
