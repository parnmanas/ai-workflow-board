/**
 * Git HTTPS hosts an account exposed to agent runs (Credential provider
 * `git_http` — e.g. a self-hosted LFS store named by a repo's `.lfsconfig`).
 *
 * git and git-lfs authenticate only through credential helpers, never through
 * plain env vars, so each host becomes command-scope git config carried in env
 * (GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n):
 *
 *   credential.<origin>.helper = ""          ← resets the helper list for this host
 *   credential.<origin>.helper = !f() …; f   ← answers `get` from two env vars
 *
 * The reset matters: command scope is read last, so without it the host's own
 * helpers (Windows Git Credential Manager, `cache`, a stale `store`) would be
 * asked first — GCM would pop an interactive login on a headless host. Other
 * hosts are untouched because the keys are URL-scoped. The secret lives only in
 * the AWB_GIT_CRED_<i>_* vars; the helper text names the vars, not the values.
 *
 * Two consumers: the spawned CLI process (merged into its env by
 * agent-env-credentials.ts) and the manager's own provisioning git — clone,
 * fetch, `worktree add` all run LFS smudge. Provisioning code does not thread
 * an env argument through every git helper; the dispatcher wraps the call in
 * `withGitHostEnv()` and each git runner asks `gitProcessEnv()`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface GitHostCredential {
  url: string;
  username: string;
  password: string;
}

const provisioningEnv = new AsyncLocalStorage<Record<string, string>>();

export function gitCredentialEnv(
  credentials: readonly GitHostCredential[],
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  // Append after any GIT_CONFIG_* the inherited env already carries.
  const offset = Math.max(0, Number.parseInt(String(baseEnv.GIT_CONFIG_COUNT ?? ''), 10) || 0);
  const env: Record<string, string> = {};
  let count = 0;
  const add = (key: string, value: string) => {
    env[`GIT_CONFIG_KEY_${offset + count}`] = key;
    env[`GIT_CONFIG_VALUE_${offset + count}`] = value;
    count += 1;
  };
  credentials.forEach((cred, i) => {
    let origin: string;
    try {
      const url = new URL(cred.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
      origin = url.origin;
    } catch {
      return;
    }
    if (!cred.username || !cred.password) return;
    const userVar = `AWB_GIT_CRED_${i}_USERNAME`;
    const passVar = `AWB_GIT_CRED_${i}_PASSWORD`;
    env[userVar] = cred.username;
    env[passVar] = cred.password;
    add(`credential.${origin}.helper`, '');
    add(
      `credential.${origin}.helper`,
      `!f() { test "$1" = get || exit 0; printf 'username=%s\\npassword=%s\\n' "$${userVar}" "$${passVar}"; }; f`,
    );
  });
  if (count) env.GIT_CONFIG_COUNT = String(offset + count);
  return env;
}

/** Run provisioning with these git host credentials visible to its git calls. */
export function withGitHostEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  return Object.keys(env).length ? provisioningEnv.run(env, fn) : fn();
}

/**
 * `env` option for a git child process: undefined (inherit) unless a
 * provisioning scope set git hosts or the caller adds its own vars.
 */
export function gitProcessEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  const hosts = provisioningEnv.getStore();
  if (!hosts && !extra) return undefined;
  return { ...process.env, ...(hosts ?? {}), ...(extra ?? {}) };
}
