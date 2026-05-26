// Unity log discovery — the use case the ticket calls out by name. Returns
// canonical paths per OS for Editor.log, Editor-prev.log, crash dir, and
// (when a project path is supplied) the Player.log derived from
// ProjectSettings companyName + productName.
//
// Generic file-tailing already exists as `read_file_tail` in tools.ts;
// keeping this module focused on the Unity-specific path resolution that
// would otherwise force the agent to encode Apple/Linux/Windows location
// trivia into its own prompt.

import { promises as fsp, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, basename } from 'node:path';

export interface FindUnityLogsArgs {
  /** When supplied, also derives the Player.log path from this project's
   *  ProjectSettings companyName + productName. */
  project_path?: string;
}

export interface UnityLogPaths {
  ok: true;
  /** Editor.log — the load-bearing one for "is the editor stuck" debug. */
  editor_log: string | null;
  /** The previous run's editor log; Unity rotates Editor.log → Editor-prev.log on launch. */
  editor_prev_log: string | null;
  /** Editor crash dumps directory (.dmp / .crash files end up here). */
  editor_crash_dir: string | null;
  /** Player.log — set only when project_path is supplied and ProjectSettings is readable. */
  player_log: string | null;
  player_prev_log: string | null;
  /** Unity Hub log (if Hub is installed). */
  hub_log: string | null;
  /** Every candidate path tried; useful diagnostic when nothing was found. */
  searched: string[];
  /** Resolved company / product when project_path was supplied. */
  project: { company_name: string | null; product_name: string | null } | null;
  platform: string;
}

export async function findUnityLogs(args: FindUnityLogsArgs): Promise<UnityLogPaths> {
  const home = homedir();
  const plat = platform();
  const searched: string[] = [];

  let editorLog: string | null = null;
  let editorPrev: string | null = null;
  let crashDir: string | null = null;
  let hubLog: string | null = null;

  if (plat === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    editorLog   = pickExisting([join(local, 'Unity', 'Editor', 'Editor.log')], searched);
    editorPrev  = pickExisting([join(local, 'Unity', 'Editor', 'Editor-prev.log')], searched);
    crashDir    = pickExisting([join(local, 'Unity', 'Editor', 'Crashes')], searched);
    hubLog      = pickExisting([join(home, 'AppData', 'Roaming', 'UnityHub', 'logs', 'info-log.json')], searched);
  } else if (plat === 'darwin') {
    editorLog   = pickExisting([join(home, 'Library', 'Logs', 'Unity', 'Editor.log')], searched);
    editorPrev  = pickExisting([join(home, 'Library', 'Logs', 'Unity', 'Editor-prev.log')], searched);
    crashDir    = pickExisting([
      join(home, 'Library', 'Logs', 'Unity', 'Editor', 'Crashes'),
      join(home, 'Library', 'Logs', 'DiagnosticReports'),
    ], searched);
    hubLog      = pickExisting([join(home, 'Library', 'Application Support', 'UnityHub', 'logs', 'info-log.json')], searched);
  } else {
    editorLog   = pickExisting([join(home, '.config', 'unity3d', 'Editor.log')], searched);
    editorPrev  = pickExisting([join(home, '.config', 'unity3d', 'Editor-prev.log')], searched);
    crashDir    = pickExisting([join(home, '.config', 'unity3d', 'Editor', 'Crashes')], searched);
    hubLog      = pickExisting([join(home, '.config', 'UnityHub', 'logs', 'info-log.json')], searched);
  }

  let projectInfo: UnityLogPaths['project'] = null;
  let playerLog: string | null = null;
  let playerPrev: string | null = null;
  if (args.project_path) {
    projectInfo = await readProjectIdentifiers(args.project_path);
    if (projectInfo.company_name && projectInfo.product_name) {
      const c = projectInfo.company_name;
      const p = projectInfo.product_name;
      if (plat === 'win32') {
        const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
        playerLog  = pickExisting([
          join(local, c, p, 'Player.log'),
          join(local, 'Low', c, p, 'Player.log'),
        ], searched);
        playerPrev = pickExisting([
          join(local, c, p, 'Player-prev.log'),
          join(local, 'Low', c, p, 'Player-prev.log'),
        ], searched);
      } else if (plat === 'darwin') {
        playerLog  = pickExisting([join(home, 'Library', 'Logs', c, p, 'Player.log')], searched);
        playerPrev = pickExisting([join(home, 'Library', 'Logs', c, p, 'Player-prev.log')], searched);
      } else {
        playerLog  = pickExisting([join(home, '.config', 'unity3d', c, p, 'Player.log')], searched);
        playerPrev = pickExisting([join(home, '.config', 'unity3d', c, p, 'Player-prev.log')], searched);
      }
    }
  }

  return {
    ok: true,
    editor_log: editorLog,
    editor_prev_log: editorPrev,
    editor_crash_dir: crashDir,
    player_log: playerLog,
    player_prev_log: playerPrev,
    hub_log: hubLog,
    searched,
    project: projectInfo,
    platform: plat,
  };
}

function pickExisting(candidates: string[], searched: string[]): string | null {
  for (const c of candidates) {
    searched.push(c);
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Read companyName + productName from a Unity project's
 * ProjectSettings/ProjectSettings.asset. Both fields live on their own
 * lines as `  companyName: <value>` / `  productName: <value>`; a regex is
 * enough since YAML formal parsing is overkill here.
 */
async function readProjectIdentifiers(projectPath: string): Promise<{ company_name: string | null; product_name: string | null }> {
  const file = join(projectPath, 'ProjectSettings', 'ProjectSettings.asset');
  if (!existsSync(file)) {
    // Project lacks readable settings — return the folder basename as a
    // best-guess product name so the agent gets *something* to try.
    return { company_name: null, product_name: basename(projectPath) || null };
  }
  try {
    const txt = await fsp.readFile(file, 'utf8');
    const company = /^\s*companyName:\s*(.+)$/m.exec(txt)?.[1]?.trim() ?? null;
    const product = /^\s*productName:\s*(.+)$/m.exec(txt)?.[1]?.trim() ?? null;
    return {
      company_name: company || null,
      product_name: product || basename(projectPath) || null,
    };
  } catch {
    return { company_name: null, product_name: basename(projectPath) || null };
  }
}
