import test from 'node:test';
import assert from 'node:assert/strict';

import {
  systemdUnit,
  windowsHiddenLauncher,
  windowsTaskXml,
} from '../dist/lib/service-install.js';

test('systemd restarts only after failure', () => {
  const unit = systemdUnit({
    execPath: '/opt/awb/dist/main.js',
    nodeBin: '/usr/bin/node',
    user: 'awb',
    isSystem: true,
  });

  assert.match(unit, /Restart=on-failure/);
  assert.doesNotMatch(unit, /Restart=always/);
});

test('Windows launcher runs Node without a visible console and forwards failures', () => {
  const launcher = windowsHiddenLauncher({
    nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
    execPath: 'C:\\Users\\awb\\AppData\\Roaming\\npm\\node_modules\\awb-agent-manager\\dist\\main.js',
  });

  assert.match(launcher, /shell\.Run\(command, 0, True\)/);
  assert.match(launcher, /WScript\.Quit rc/);
  assert.match(launcher, /""C:\\Program Files\\nodejs\\node\.exe""/);
});

test('Windows task is hidden and restarts only when the launcher fails', () => {
  const xml = windowsTaskXml({
    launcherPath: 'C:\\Users\\a&b\\service\\launch-hidden.vbs',
    wscriptPath: 'C:\\Windows\\System32\\wscript.exe',
    user: 'awb',
    isSystem: false,
  });

  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /<RestartOnFailure>/);
  assert.match(xml, /<Command>C:\\Windows\\System32\\wscript\.exe<\/Command>/);
  assert.match(xml, /a&amp;b/);
  assert.doesNotMatch(xml, /node\.exe/);
});
