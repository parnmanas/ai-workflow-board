// Self-update stub for ST-3: the manager is distributed via npm rather than a
// git checkout, so the daemon-style "git pull --ff-only + re-exec" path no
// longer applies. We log guidance instead and return a structured "no-op"
// result so callers can keep the same control surface as the legacy daemon.

import { log } from './logging.js';

export interface SelfUpdateResult {
  changed: boolean;
  summary: string;
}

export interface SelfUpdateOpts {
  log?: (msg: string) => void;
}

export async function runSelfUpdate(opts: SelfUpdateOpts = {}): Promise<SelfUpdateResult> {
  const out = opts.log ?? log;
  const summary =
    'self-update is a no-op in agent-manager — install upgrades via `npm i -g @awb/agent-manager@latest`';
  out(`Self-update: ${summary}`);
  return { changed: false, summary };
}
