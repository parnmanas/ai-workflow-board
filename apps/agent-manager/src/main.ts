#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

function printHelp() {
  process.stdout.write(`awb-agent-manager — standalone AWB subagent runner

Usage:
  awb-agent-manager [options]

Options:
  -c, --config <path>     Path to config.json (default: platform XDG config dir)
  -w, --workspace <id>    Override workspace_id from config
      --dry-run           Load config and exit without starting runtime
  -h, --help              Show this help text
  -v, --version           Print version

Notes:
  - This is a scaffold (ST-1). Runtime modules will be migrated from the
    claude-plugins daemon in ST-2 and wired up here.
`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    return;
  }

  if (flags.version) {
    process.stdout.write(`${readPkgVersion()}\n`);
    return;
  }

  process.stdout.write(
    `awb-agent-manager v${readPkgVersion()} (scaffold — runtime not yet implemented)\n`,
  );
  if (flags.config) process.stdout.write(`  --config:    ${flags.config}\n`);
  if (flags.workspace) process.stdout.write(`  --workspace: ${flags.workspace}\n`);
  if (flags.dryRun) process.stdout.write(`  --dry-run:   true\n`);
}

main().catch((err) => {
  process.stderr.write(`agent-manager: fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
