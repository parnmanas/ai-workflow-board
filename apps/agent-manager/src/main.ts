#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  AGENT_MANAGER_HOME,
  CONFIG_PATH,
  LEGACY_CONFIG_PATH,
} from './lib/constants.js';
import { loadConfig } from './lib/config.js';
import { installCrashHandlers, log } from './lib/logging.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CliFlags {
  config?: string;
  workspace?: string;
  dryRun: boolean;
  help: boolean;
  version: boolean;
}

function readPkgVersion(): string {
  try {
    const pkgPath = resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseFlags(argv: string[]): CliFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      workspace: { type: 'string', short: 'w' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
    strict: false,
  });

  return {
    config: values.config as string | undefined,
    workspace: values.workspace as string | undefined,
    dryRun: Boolean(values['dry-run']),
    help: Boolean(values.help),
    version: Boolean(values.version),
  };
}

function printHelp(): void {
  process.stdout.write(`awb-agent-manager — standalone AWB subagent runner

Usage:
  awb-agent-manager [options]

Options:
  -c, --config <path>     Path to config.json (default: ${CONFIG_PATH})
  -w, --workspace <id>    Override workspace_id from config
      --dry-run           Load config and exit without starting runtime
  -h, --help              Show this help text
  -v, --version           Print version

Config search order:
  1. --config flag
  2. $AWB_AGENT_MANAGER_HOME/config.json
  3. $XDG_CONFIG_HOME/awb-agent-manager/config.json (or %APPDATA% on Windows)
  4. ~/.config/awb-agent-manager/config.json
  5. Legacy claude-plugin path (auto-import in ST-3): ${LEGACY_CONFIG_PATH}

Notes:
  - This is a scaffold (ST-1 + ST-2 phase A). Runtime modules (event-stream,
    session managers, subagent runner, cli adapters) are migrated incrementally.
`);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    return;
  }
  if (flags.version) {
    process.stdout.write(`${readPkgVersion()}\n`);
    return;
  }

  installCrashHandlers();

  process.stdout.write(
    `awb-agent-manager v${readPkgVersion()} (scaffold — runtime not yet implemented)\n`,
  );
  process.stdout.write(`  home:        ${AGENT_MANAGER_HOME}\n`);

  const configPath = flags.config ?? CONFIG_PATH;
  const config = loadConfig(configPath);
  if (config) {
    process.stdout.write(`  config:      ${configPath}\n`);
    process.stdout.write(`  url:         ${config.url}\n`);
    process.stdout.write(`  workspace:   ${flags.workspace ?? config.workspace_id ?? '(none)'}\n`);
    process.stdout.write(`  cli:         ${config.cli ?? 'claude'}\n`);
  } else {
    process.stdout.write(`  config:      not found at ${configPath}\n`);
    process.stdout.write(
      `  hint:        config auto-import from ${LEGACY_CONFIG_PATH} lands in ST-3\n`,
    );
  }

  if (flags.dryRun) {
    log(`--dry-run: exiting after config load (config=${config ? 'loaded' : 'missing'})`);
    return;
  }

  log('runtime not yet implemented — exiting cleanly');
}

main().catch((err) => {
  process.stderr.write(`agent-manager: fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
