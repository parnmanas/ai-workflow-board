// Static parity guard — every SSE payload field declared in stream-events.ts
// MUST be forwarded by its event-registry `map()`. Generalizes the single-field
// run_provision guard (qa-run-provision-sse-forward-guard) to ALL event types.
//
// 근본 함정 (ticket 665bd10c / 회고 fe297886):
//   event-registry.ts 의 각 `map()` 은 payload 를 **필드별로 손으로 재구성**한다
//   (`const payload: XxxPayload = { ... }`). payload 타입에 optional 필드가 새로
//   추가돼도 그 키를 map() 에 손으로 적지 않으면 SSE 직렬화에서 **조용히 누락**된다.
//   TypeScript 는 부분 객체 리터럴(누락 필드가 optional)을 에러로 잡지 못하므로
//   컴파일·기존 테스트가 모두 통과하고 런타임 wire 에서만 필드가 사라진다.
//   소비자(agent-manager / 웹 UI)가 그 필드에 의존하면 증상이 엉뚱한 곳에서 터져
//   (executor 미spawn 등) 진단이 매우 어렵다.
//
// 이 가드는 stream-events.ts 의 각 `*Payload` 인터페이스의 **선언 필드 집합**을
// event-registry.ts 의 해당 `map()` payload 객체 리터럴이 **실제로 설정하는 키
// 집합**과 비교해, 타입에 있는데 map() 에 없는 필드가 생기면 실패한다. 한 단계
// 중첩된 inline 객체 타입(예: agent_status.current_task, agent_instance_update.
// instance)도 검사한다. 신규 필드가 map() 누락된 채 머지되는 걸 머지 시점에 잡는다.
//
// conditional-omit 보존: 이 가드는 키의 **존재**만 본다 (값은 보지 않는다). 따라서
//   `type: event.type === 'progress' ? event.type : undefined`
// 같은 조건부-누락 패턴은 키가 그대로 존재하므로 통과한다 — legacy wire-shape 안정성
// (chat_room_message) 는 회귀 없이 유지된다.
//
// 패턴은 qa-run-provision-sse-forward-guard.test.mjs 의 정신을 따르되, 단일 필드
// regex 대신 TypeScript AST 로 모든 타입·필드를 자동 커버한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TYPES_REL = 'common/types/stream-events.ts';
const REGISTRY_REL = 'modules/events/event-registry.ts';

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// ── Parse stream-events.ts interfaces ──────────────────────────────────────
// Returns Map<interfaceName, { fields: Set<string>, nested: Map<field, Set<string>> }>.
// `nested` carries the sub-field set ONLY for fields whose declared type is a
// single inline object literal (TypeLiteral) — unions (`{...} | null`), arrays
// (`Array<{...}>`), and named type references are intentionally not recursed
// into (their shape is pass-through or too variable to assert structurally).
function parseInterfaces(source) {
  const sf = ts.createSourceFile('stream-events.ts', source, ts.ScriptTarget.Latest, true);
  const out = new Map();
  sf.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node)) return;
    const fields = new Set();
    const nested = new Map();
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) continue;
      const fname = member.name.text;
      fields.add(fname);
      if (member.type && ts.isTypeLiteralNode(member.type)) {
        const sub = new Set();
        for (const s of member.type.members) {
          if (ts.isPropertySignature(s) && s.name && ts.isIdentifier(s.name)) sub.add(s.name.text);
        }
        nested.set(fname, sub);
      }
    }
    out.set(node.name.text, { fields, nested });
  });
  return out;
}

// ── Collect the shallowest object-literal keys within a value node ─────────
// For `instance: { a, b }` → {a,b}. For a ternary `cond ? { a } : undefined`
// → {a} (both branches unioned). Stops at the first object literal on each
// path so DEEPER nesting isn't flattened in. Returns null when the value
// contains no object literal (pass-through like `event.foo`).
function shallowObjectKeys(valueNode) {
  const objs = [];
  const visit = (n) => {
    if (ts.isObjectLiteralExpression(n)) {
      objs.push(n);
      return; // don't descend into this object's own properties
    }
    n.forEachChild(visit);
  };
  visit(valueNode);
  if (objs.length === 0) return null;
  const keys = new Set();
  for (const o of objs) {
    for (const p of o.properties) {
      if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) keys.add(p.name.text);
    }
  }
  return keys;
}

// ── Extract a map()'s payload literal ──────────────────────────────────────
// Finds `const payload: XxxPayload = { ... }` anywhere in the map body and
// returns { typeName, keys, spread, nested }. `spread` is true when the literal
// uses `...x` (approach-A forwarding) — such maps forward everything and are
// exempt from the strict field check.
function extractPayloadLiteral(mapNode) {
  let result = null;
  const visit = (n) => {
    if (result) return;
    if (
      ts.isVariableDeclaration(n) &&
      n.type &&
      ts.isTypeReferenceNode(n.type) &&
      n.initializer &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      const typeName = n.type.typeName.getText();
      if (/Payload$/.test(typeName)) {
        const keys = new Set();
        const nested = new Map();
        let spread = false;
        for (const p of n.initializer.properties) {
          if (ts.isSpreadAssignment(p)) {
            spread = true;
            continue;
          }
          let key = null;
          if (p.name && ts.isIdentifier(p.name)) key = p.name.text;
          else if (p.name && ts.isStringLiteral(p.name)) key = p.name.text;
          if (!key) continue;
          keys.add(key);
          if (ts.isPropertyAssignment(p)) {
            const sub = shallowObjectKeys(p.initializer);
            if (sub) nested.set(key, sub);
          }
        }
        result = { typeName, keys, spread, nested };
        return;
      }
    }
    n.forEachChild(visit);
  };
  visit(mapNode);
  return result;
}

// ── Parse the EVENT_TYPES table ─────────────────────────────────────────────
// Returns [{ eventType, typeName, keys, spread, nested }].
function parseRegistryMaps(source) {
  const sf = ts.createSourceFile('event-registry.ts', source, ts.ScriptTarget.Latest, true);
  let arr = null;
  sf.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === 'EVENT_TYPES' &&
        decl.initializer &&
        ts.isArrayLiteralExpression(decl.initializer)
      ) {
        arr = decl.initializer;
      }
    }
  });
  const maps = [];
  if (!arr) return maps;
  for (const el of arr.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue;
    let eventType = null;
    let mapNode = null;
    for (const p of el.properties) {
      const pname = p.name && ts.isIdentifier(p.name) ? p.name.text : null;
      if (pname === 'eventType' && ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)) {
        eventType = p.initializer.text;
      }
      if (pname === 'map') {
        if (ts.isMethodDeclaration(p)) mapNode = p;
        else if (ts.isPropertyAssignment(p)) mapNode = p.initializer;
      }
    }
    if (!mapNode) continue;
    const lit = extractPayloadLiteral(mapNode);
    if (lit) maps.push({ eventType, ...lit });
  }
  return maps;
}

// ── The parity computation (pure → reused by the mutation test) ─────────────
function computeViolations(registrySource, typesSource) {
  const interfaces = parseInterfaces(typesSource);
  const maps = parseRegistryMaps(registrySource);
  const violations = [];
  for (const m of maps) {
    if (m.spread) continue; // approach-A spread forwards every field
    const iface = interfaces.get(m.typeName);
    if (!iface) {
      violations.push({ eventType: m.eventType, typeName: m.typeName, kind: 'unknown-type' });
      continue;
    }
    for (const f of iface.fields) {
      if (!m.keys.has(f)) {
        violations.push({ eventType: m.eventType, typeName: m.typeName, field: f, kind: 'missing' });
      }
    }
    for (const [field, subFields] of iface.nested) {
      if (!m.keys.has(field)) continue; // already flagged as a top-level miss
      const mapNested = m.nested.get(field);
      if (!mapNested) continue; // map forwards the field whole (pass-through) — fine
      for (const s of subFields) {
        if (!mapNested.has(s)) {
          violations.push({
            eventType: m.eventType,
            typeName: m.typeName,
            field: `${field}.${s}`,
            kind: 'missing-nested',
          });
        }
      }
    }
  }
  return { violations, maps, interfaces };
}

// Remove the first top-level `<field>: ...,` property line from the source —
// used by the mutation test to prove the guard has teeth.
function dropFieldLine(source, field) {
  const re = new RegExp(`^[ \\t]*${field}:[^\\n]*\\n`, 'm');
  return source.replace(re, '');
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('every event-registry map() forwards all declared top-level payload fields', () => {
  const { violations, maps } = computeViolations(read(REGISTRY_REL), read(TYPES_REL));
  const missing = violations.filter((v) => v.kind === 'missing' || v.kind === 'unknown-type');
  assert.equal(
    missing.length,
    0,
    `payload fields declared in stream-events.ts but DROPPED by their event-registry map():\n` +
      missing
        .map((v) =>
          v.kind === 'unknown-type'
            ? `  - ${v.eventType}: map uses unknown payload type ${v.typeName}`
            : `  - ${v.eventType} (${v.typeName}): missing "${v.field}" — add it to the map() literal or the field silently vanishes on the SSE wire`,
        )
        .join('\n'),
  );
  // Sanity: the parser actually found the table (not silently zero maps).
  assert.ok(maps.length >= 19, `expected >= 19 event maps parsed, got ${maps.length}`);
});

test('nested inline payload objects forward all declared sub-fields', () => {
  const { violations } = computeViolations(read(REGISTRY_REL), read(TYPES_REL));
  const nestedMiss = violations.filter((v) => v.kind === 'missing-nested');
  assert.equal(
    nestedMiss.length,
    0,
    `nested payload sub-fields DROPPED by their map():\n` +
      nestedMiss.map((v) => `  - ${v.eventType} (${v.typeName}): missing "${v.field}"`).join('\n'),
  );
});

test('parser covers the known event types (tripwire against lost coverage)', () => {
  const { maps } = computeViolations(read(REGISTRY_REL), read(TYPES_REL));
  const seen = new Set(maps.map((m) => m.eventType));
  for (const expected of [
    'board_update',
    'agent_typing',
    'agent_trigger',
    'chat_message',
    'agent_status',
    'chat_request',
    'chat_room_message',
    'chat_room_update',
    'chat_room_typing',
    'comment_mention',
    'user_mention',
    'ticket_presence',
    'comment_typing',
    'fs_request',
    'subagent_registered',
    'subagent_log',
    'subagent_ended',
    'agent_instance_update',
    'agent_manager_command',
    'consensus_update',
  ]) {
    assert.ok(seen.has(expected), `parity guard lost coverage of event type "${expected}"`);
  }
});

test('chat_room_message conditional-omit fields are preserved (legacy wire-shape)', () => {
  // These optional fields are intentionally omitted-when-absent so legacy
  // consumers see a byte-for-byte unchanged wire. The parity guard requires the
  // KEYS to exist; this test additionally pins the conditional VALUE so a future
  // refactor can't flip them to unconditional and change the legacy shape.
  const code = read(REGISTRY_REL).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(code, /type:\s*event\.type === 'progress' \|\| event\.type === 'message'\s*\?\s*event\.type\s*:\s*undefined/);
  assert.match(code, /attachments:\s*Array\.isArray\(event\.attachments\)[\s\S]*?:\s*undefined/);
  assert.match(code, /run_provision:\s*event\.run_provision \? event\.run_provision : undefined/);
});

test('agent_trigger flatten() forwards every manager-consumed field', () => {
  // agent-manager's event-dispatcher reads these off the FLATTENED agent_trigger
  // event. flatten() previously dropped effort_preset / environment_config /
  // force_respawn → board effort presets + environment provisioning + server
  // force-respawn silently no-op'd (the latent bug this ticket fixed). Lock the
  // wire so a flatten refactor can't re-break it.
  //
  // worktree_mode (규약 ②) + worktree_rel_path (규약 ④) are the newest additions:
  // the manager reads worktree_mode to place the worktree under `.awb/wt/` and
  // worktree_rel_path to fill the `{{AWB_WORK_FOLDER}}` column-prompt placeholder
  // with the real spawn cwd. Drop either from flatten() and the worktree lands in
  // the wrong place / the work-folder rule silently loses its path.
  const code = read(REGISTRY_REL);
  const flat = code.slice(code.indexOf("eventType: 'agent_trigger'"));
  for (const field of [
    'harness_config',
    'effort_preset',
    'environment_config',
    'force_respawn',
    'column_prompt',
    'max_concurrent_tickets_per_agent',
    'worktree_mode',
    'worktree_rel_path',
  ]) {
    assert.match(
      flat,
      new RegExp(`${field}:\\s*p\\.${field}`),
      `agent_trigger flatten() must forward p.${field} — agent-manager reads it off the flattened event`,
    );
  }
});

test('mutation: dropping a forwarded field is detected, and ONLY that field', () => {
  const registry = read(REGISTRY_REL);
  const types = read(TYPES_REL);

  // Baseline must be clean (real source), or the mutation signal is meaningless.
  const base = computeViolations(registry, types).violations;
  assert.deepEqual(base, [], `baseline parity must be clean, got: ${JSON.stringify(base)}`);

  // Mutate: drop run_provision from the chat_room_message map literal.
  const mutated = dropFieldLine(registry, 'run_provision');
  assert.notEqual(mutated, registry, 'mutation must actually change the source');

  const after = computeViolations(mutated, types).violations;
  const hit = after.find((v) => v.eventType === 'chat_room_message' && v.field === 'run_provision');
  assert.ok(hit, 'guard must flag the dropped run_provision field');
  assert.equal(
    after.length,
    1,
    `mutation must flag EXACTLY the dropped field, got: ${JSON.stringify(after)}`,
  );

  // A second, independent mutation on a different event type, to prove the
  // detection isn't hard-coded to one map.
  const mutated2 = dropFieldLine(registry, 'effort_preset');
  const after2 = computeViolations(mutated2, types).violations;
  // effort_preset appears in both map() and flatten(); dropFieldLine removes the
  // first occurrence (the map literal), so exactly the agent_trigger field trips.
  assert.ok(
    after2.some((v) => v.eventType === 'agent_trigger' && v.field === 'effort_preset'),
    'guard must flag a dropped agent_trigger.effort_preset',
  );
});
