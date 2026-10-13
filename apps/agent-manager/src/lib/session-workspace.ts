import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, appendFile, rename, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}

export interface SessionWorkspace {
  cwd: string;
  repo: string;
  base: string;
  branch?: string;
  root?: string;
  workflow: string;
  cleaned?: boolean;
}

/** Only directories and branches created by this manager are eligible for cleanup. */
export class SessionWorkspaces {
  constructor(private readonly stateDir: string) {}

  private file(cli: string, id: string): string {
    return join(this.stateDir, `${createHash('sha256').update(`${cli}/${id}`).digest('hex')}.json`);
  }

  async save(cli: string, id: string, workspace: SessionWorkspace): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const target = this.file(cli, id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(workspace), { mode: 0o600 });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  async prepare(cli: string, id: string, cwd: string, workflow = 'main'): Promise<SessionWorkspace | null> {
    if (id) {
      try {
        const saved: SessionWorkspace = JSON.parse(await readFile(this.file(cli, id), 'utf8'));
        if (saved.cleaned) throw new Error('This session’s merged worktree has been removed. Start a new session in the main repository.');
        return saved;
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        // Native sessions and older AWB sessions keep their original working directory.
        return null;
      }
    }
    let repo: string;
    try { repo = await git(cwd, 'rev-parse', '--show-toplevel'); }
    catch {
      if (workflow !== 'main') throw new Error('Worktree / PR sessions require a Git repository.');
      return null;
    }
    cwd = await realpath(cwd);
    repo = await realpath(repo);
    let base = '';
    for (const candidate of ['main', 'master']) {
      if (await git(repo, 'show-ref', '--verify', `refs/heads/${candidate}`).then(() => true, () => false)) { base = candidate; break; }
    }
    if (!base) throw new Error('No local main or master branch exists. Create the repository’s main branch before starting a session.');
    if (workflow === 'main') {
      const branch = await git(repo, 'branch', '--show-current');
      if (branch !== base) {
        if (await git(repo, 'status', '--porcelain', '--untracked-files=all')) {
          throw new Error(`The repository is on ${branch || 'detached HEAD'} with local changes. Commit or move those changes before starting on ${base}.`);
        }
        await git(repo, 'switch', base);
      }
      return { cwd, repo, base, workflow };
    }
    const token = randomUUID();
    const root = join(repo, '.awb', 'session-wt', token);
    const branch = `awb/session-${token}`;
    // Keep managed worktrees out of the parent repository's untracked files.
    const exclude = await git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
    const exclusions = await readFile(exclude, 'utf8').catch(() => '');
    if (!exclusions.split('\n').includes('/.awb/session-wt/')) await appendFile(exclude, '\n/.awb/session-wt/\n');
    await mkdir(join(repo, '.awb', 'session-wt'), { recursive: true });
    await git(repo, 'worktree', 'add', '-b', branch, root, base);
    return { cwd: join(root, relative(repo, cwd)), repo, base, branch, root, workflow };
  }

  async cleanup(workspace: SessionWorkspace): Promise<string> {
    if (!workspace.root || !workspace.branch || workspace.cleaned) return '';
    const { root, repo, branch, base } = workspace;
    try {
      if (await git(root, 'branch', '--show-current') !== branch) return 'Worktree retained: its branch has changed.';
      const head = await git(repo, 'rev-parse', `refs/heads/${branch}`);
      if (await git(root, 'status', '--porcelain', '--untracked-files=all')) return 'Worktree retained: it has uncommitted or untracked files.';
      const merged = await git(repo, 'merge-base', '--is-ancestor', head, base).then(() => true, () => false);
      // A nonempty topic diff whose resulting tree is now the base also covers a
      // squash merge. An unmerged edit/revert series is not proof of integration.
      const fork = await git(repo, 'merge-base', head, base);
      const topicTree = await git(repo, 'rev-parse', `${head}^{tree}`);
      const sameTree = topicTree === await git(repo, 'rev-parse', `${base}^{tree}`)
        && topicTree !== await git(repo, 'rev-parse', `${fork}^{tree}`);
      if (!merged && !sameTree) return `Worktree retained: merge into local ${base} could not be verified. Update the base branch and close this session again.`;
      await git(repo, 'worktree', 'remove', root);
      // Compare-and-delete only the exact verified commit; never force-delete a changed ref.
      await git(repo, 'update-ref', '-d', `refs/heads/${branch}`, head);
      workspace.cleaned = true;
      return 'Merged session worktree and local branch removed.';
    } catch (error: any) {
      return `Worktree cleanup incomplete: ${error.message}`;
    }
  }

  async discard(cli: string, id: string, workspace: SessionWorkspace): Promise<void> {
    await this.cleanup(workspace);
    if (workspace.cleaned) await unlink(this.file(cli, id)).catch(() => undefined);
  }
}

export function sessionWorkflowInstruction(workspace: SessionWorkspace | null): string {
  if (!workspace) return '';
  const common = `Session Git workflow: ${workspace.workflow}. Working directory: ${workspace.cwd}. Base branch: ${workspace.base}. `;
  if (workspace.workflow === 'main') return common + 'Work directly on the base branch. Do not create a branch, worktree or pull request unless the user explicitly changes this workflow.';
  return common + `Use the existing session worktree and branch ${workspace.branch}; do not create additional worktrees. `
    + (workspace.workflow === 'pr' ? 'Open a pull request for review; do not merge without authorization. ' : 'When the task authorizes landing, merge the completed work into the base branch. ')
    + 'After an authorized merge, delete the remote topic branch if one was pushed. AWB removes this managed worktree and local branch when the session is closed and the local base contains the work. Do not remove the session working directory yourself.';
}
