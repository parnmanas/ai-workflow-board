import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

const root = new URL('../src/lib/runtime/', import.meta.url).pathname;
const layers = ['domain', 'ports', 'application', 'adapters', 'composition'];
const rank = new Map([['domain', 0], ['ports', 1], ['application', 2], ['adapters', 3], ['composition', 4]]);

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
}

test('runtime 계층은 역방향·adapter 간 import와 순환을 만들지 않는다', () => {
  const violations = [];
  const graph = new Map();
  for (const file of files(root)) {
    const rel = relative(root, file).replaceAll('\\', '/');
    const layer = rel.split('/')[0];
    if (!layers.includes(layer)) continue;
    const imports = [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
    graph.set(rel, []);
    for (const specifier of imports) {
      const targetLayer = layers.find(candidate => specifier.includes(`/${candidate}/`) || specifier.startsWith(`../${candidate}/`));
      if (!targetLayer) continue;
      if (rank.get(targetLayer) > rank.get(layer)) violations.push(`${rel} -> ${specifier}`);
      if (layer === 'adapters' && targetLayer === 'adapters') violations.push(`${rel} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
  assert.ok(graph.size >= 5, '모든 runtime 계층에 검사 대상 파일이 있어야 한다');
});
