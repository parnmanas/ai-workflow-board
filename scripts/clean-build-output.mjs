import { rm } from 'node:fs/promises';

// Turbo restores cached files over existing directories. Remove old output
// first so deleted modules cannot survive a cache hit and be auto-discovered.
await Promise.all(['server', 'client', 'agent-manager'].map(app =>
  rm(new URL(`../apps/${app}/dist/`, import.meta.url), { recursive: true, force: true }),
));
