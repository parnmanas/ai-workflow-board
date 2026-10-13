import { cliModule } from './clis/index.js';
import type { CliSessionLaunchOption } from './clis/cli-module.js';

export const SESSION_PERMISSION_KEY = '__permission_mode';
export const SESSION_WORKFLOW_KEY = '__git_workflow';

const workflow: CliSessionLaunchOption = {
  config_id: SESSION_WORKFLOW_KEY, name: 'Git workflow', category: 'launch', type: 'select', current_value: 'main',
  description: 'Choose where this session works. Managed worktrees are removed on close only when clean and merged into the base branch.',
  options: [
    { value: 'main', name: 'Main / master (default)', description: 'Work in the selected repository on main/master. Do not create a branch, worktree or PR. A different branch with local changes must be resolved first.' },
    { value: 'worktree', name: 'Worktree', description: 'Create a session branch and worktree. Merge into the base branch when finished; closing the session cleans up a clean, merged worktree.' },
    { value: 'pr', name: 'Worktree + pull request', description: 'Create a session branch and worktree, then open a PR. Keep it until merged. Closing the session cleans up only verified merged work.' },
  ],
};

export function sessionLaunchOptions(cli: string): CliSessionLaunchOption[] {
  if (!cliModule(cli)?.sessions) return [];
  return [...(cliModule(cli)?.sessions?.launchOptions ?? []), workflow];
}

export function validateSessionLaunchOptions(cli: string, defaults: Record<string, string | boolean> = {}): void {
  const options = sessionLaunchOptions(cli);
  for (const key of [SESSION_PERMISSION_KEY, SESSION_WORKFLOW_KEY]) {
    if (defaults[key] === undefined) continue;
    if (!options.find((o) => o.config_id === key)?.options.some((o) => o.value === defaults[key])) {
      throw new Error(`Unsupported session option ${key}=${String(defaults[key])} for ${cli}`);
    }
  }
}
