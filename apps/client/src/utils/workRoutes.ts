/** Normalize bookmarked work URLs without changing their execution account. */
export function canonicalWorkPath(pathname: string): string {
  const path = pathname.replace(/^\/ws\/[^/]+(?=\/|$)/, '') || '/sessions';
  if (/^\/(boards(?:\/|$)|board\/settings(?:\/|$))/.test(path)) return '/tickets';
  if (/^\/(agents(?:\/|$)|dashboard$|assistant$)/.test(path)) return '/sessions';
  if (path === '/orchestration/teams') return '/teams';
  if (/^\/orchestration(?:\/missions)?\/?$/.test(path)) return '/missions';
  if (path.startsWith('/orchestration/missions/')) return path.replace('/orchestration/missions/', '/missions/');
  const aliases: Record<string, string> = {
    '/settings/workspace': '/settings/ownership',
    '/users': '/settings/members',
    '/channels': '/settings/channels',
    '/api-keys': '/settings/api-keys',
    '/credentials': '/settings/credentials',
    '/catalog': '/functions',
    '/claude-backend-profiles': '/settings/claude-profiles',
  };
  return aliases[path] || path;
}
