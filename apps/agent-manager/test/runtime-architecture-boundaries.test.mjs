import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import test from 'node:test';

const libRoot = new URL('../src/lib/', import.meta.url).pathname;
const runtimeRoot = join(libRoot, 'runtime');
const layers = ['domain', 'ports', 'application', 'adapters', 'composition'];
const rank = new Map([['domain', 0], ['ports', 1], ['application', 2], ['adapters', 3], ['composition', 4]]);
const legacyRuntimeFiles = new Set([
  'base-session-manager.ts', 'chat-session-manager.ts', 'ticket-session-manager.ts',
  'subagent-manager.ts', 'event-dispatcher.ts', 'process-tree.ts', 'mcp-client.ts',
  'cli-error-signatures.ts', 'cli-usage-accumulator.ts',
]);

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
}

function imports(file) {
  return [...readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
}

function resolveImport(file, specifier) {
  if (!specifier.startsWith('.')) return null;
  const raw = resolve(dirname(file), specifier.replace(/\.js$/, ''));
  for (const candidate of [`${raw}.ts`, join(raw, 'index.ts')]) if (existsSync(candidate)) return normalize(candidate);
  return null;
}

function layerOf(file) {
  const rel = relative(runtimeRoot, file).replaceAll('\\', '/');
  const layer = rel.split('/')[0];
  return layers.includes(layer) ? layer : null;
}

test('전체 agent 런타임 그래프는 역방향·순환·코어의 infrastructure 의존을 차단한다', () => {
  const all = files(libRoot);
  const scoped = all.filter(file => file.startsWith(runtimeRoot) || legacyRuntimeFiles.has(relative(libRoot, file).replaceAll('\\', '/')) || relative(libRoot, file).replaceAll('\\', '/').startsWith('cli-adapters/'));
  const scopedSet = new Set(scoped.map(normalize));
  const graph = new Map();
  const violations = [];

  for (const file of scoped) {
    const rel = relative(libRoot, file).replaceAll('\\', '/');
    const sourceLayer = layerOf(file);
    graph.set(rel, []);
    for (const specifier of imports(file)) {
      if (sourceLayer === 'domain' && (!specifier.startsWith('.') || specifier.includes('adapters') || specifier.includes('composition'))) {
        violations.push(`domain 외부 의존: ${rel} -> ${specifier}`);
      }
      if (sourceLayer === 'application' && /^(node:child_process|node:fs)|cli-adapters|\/adapters\//.test(specifier)) {
        violations.push(`application infrastructure 의존: ${rel} -> ${specifier}`);
      }
      const targetFile = resolveImport(file, specifier);
      if (!targetFile || !scopedSet.has(targetFile)) continue;
      const target = relative(libRoot, targetFile).replaceAll('\\', '/');
      graph.get(rel).push(target);
      const targetLayer = layerOf(targetFile);
      if (sourceLayer && targetLayer && rank.get(targetLayer) > rank.get(sourceLayer)) violations.push(`역방향: ${rel} -> ${specifier}`);
      if (sourceLayer === 'adapters' && targetLayer === 'adapters') violations.push(`adapter 결합: ${rel} -> ${specifier}`);
    }
  }

  const active = new Set();
  const done = new Set();
  function visit(node, path = []) {
    if (active.has(node)) { violations.push(`순환: ${[...path.slice(path.indexOf(node)), node].join(' -> ')}`); return; }
    if (done.has(node)) return;
    active.add(node);
    for (const target of graph.get(node) ?? []) visit(target, [...path, node]);
    active.delete(node); done.add(node);
  }
  for (const node of graph.keys()) visit(node);

  assert.deepEqual(violations, []);
  assert.ok(graph.size >= 25, `실제 전환 대상 전체를 검사해야 한다: ${graph.size}`);
  assert.ok([...graph.keys()].some(file => file === 'base-session-manager.ts'));
  assert.ok([...graph.keys()].some(file => file.startsWith('cli-adapters/')));
});
