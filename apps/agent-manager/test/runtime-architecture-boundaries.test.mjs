import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
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
  const runtimeFiles = files(root);
  const knownFiles = new Set(runtimeFiles.map(file => normalize(file)));
  for (const file of runtimeFiles) {
    const rel = relative(root, file).replaceAll('\\', '/');
    const layer = rel.split('/')[0];
    if (!layers.includes(layer)) continue;
    const imports = [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
    graph.set(rel, []);
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) continue;
      const candidate = normalize(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      if (!knownFiles.has(candidate)) continue;
      const target = relative(root, candidate).replaceAll('\\', '/');
      const targetLayer = target.split('/')[0];
      if (!targetLayer) continue;
      if (rank.get(targetLayer) > rank.get(layer)) violations.push(`${rel} -> ${specifier}`);
      if (layer === 'adapters' && targetLayer === 'adapters') violations.push(`${rel} -> ${specifier}`);
      graph.get(rel).push(target);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(node, path = []) {
    if (visiting.has(node)) {
      violations.push(`순환: ${[...path.slice(path.indexOf(node)), node].join(' -> ')}`);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of graph.get(node) ?? []) visit(target, [...path, node]);
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of graph.keys()) visit(node);

  assert.deepEqual(violations, []);
  assert.ok(graph.size >= 5, '모든 runtime 계층에 검사 대상 파일이 있어야 한다');
});
