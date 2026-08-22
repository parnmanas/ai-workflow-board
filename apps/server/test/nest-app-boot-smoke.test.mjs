// Boot smoke test — ticket b209659a.
//
// `nest build` (tsc) only type-checks; NestJS resolves its DI graph at
// runtime, so a controller decorated with e.g. @UseGuards(PermissionGuard)
// whose module forgets to register PermissionGuard's own dependency
// (AuthGuard) compiles cleanly and then throws UnknownDependenciesException
// the moment something actually calls NestFactory.create(AppModule) — which,
// until now, only happened by an engineer manually running
// `node apps/server/dist/main.js` locally. This file makes that check
// automatic and puts it first in `npm test` (before the ~90 qa-flows files
// that incidentally boot the same AppModule but bury a wiring failure deep
// in an unrelated-looking test).
//
// Verified this actually catches the bug class it targets: temporarily
// dropped AuthGuard from ResourcesModule's providers (an existing, otherwise
// correctly-wired module) and confirmed this boot throws
// UnknownDependenciesException naming PermissionGuard/AuthGuard/
// ResourcesModule; restored the file immediately after.
//
// abortOnError:false (see bootAppModuleOnly in helpers/boot.mjs) is required
// for the failure to surface as a catchable exception instead of NestFactory
// calling process.exit(1) itself and killing the test worker silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootAppModuleOnly } from './helpers/boot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_MODULE_DIST = path.resolve(__dirname, '..', 'dist', 'app.module.js');

test('AppModule boots through the real NestJS DI container (catches guard/provider wiring bugs tsc cannot see)', async () => {
  if (!fs.existsSync(APP_MODULE_DIST)) {
    console.warn('skip: dist/app.module.js not built — run `nest build` (or `npm test`, which builds first) to exercise this');
    return;
  }

  let app;
  try {
    app = await bootAppModuleOnly();
  } catch (err) {
    assert.fail(
      `NestFactory.create(AppModule) failed to boot — a controller's @UseGuards() likely names a guard whose own ` +
      `constructor dependency isn't registered in that module's providers[] (directly or via an imported module's ` +
      `exports[]). Original error:\n${err?.message ?? err}`,
    );
  }
  assert.ok(app, 'NestFactory.create(AppModule) must return an app instance');
  await app.close();
});
