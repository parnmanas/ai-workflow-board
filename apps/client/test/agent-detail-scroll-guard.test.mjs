import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const detailSource = await readFile(
  new URL('../src/components/AgentDetailModal.tsx', import.meta.url),
  'utf8',
);

test('app content can shrink to the flex-allocated viewport height', () => {
  const contentRule = mainSource.match(/\.awb-content\s*\{(?<body>[^}]*)\}/)?.groups?.body;

  assert.ok(contentRule, '.awb-content rule must exist');
  assert.match(contentRule, /\bflex:\s*1\s*;/);
  assert.match(contentRule, /\bmin-height:\s*0\s*;/);
  assert.match(contentRule, /\boverflow-y:\s*auto\s*;/);
});

test('agent detail body preserves its bounded vertical scrolling contract', () => {
  const scrollBody = detailSource.match(
    /\{\/\*\s*Scroll body[\s\S]*?<div\s+style=\{\{(?<body>[\s\S]*?)\}\}/,
  )?.groups?.body;

  assert.ok(scrollBody, 'Agent Content scroll body must exist');
  assert.match(scrollBody, /\bflex:\s*1\s*,/);
  assert.match(scrollBody, /\boverflowY:\s*['"]auto['"]\s*,/);
  assert.match(scrollBody, /\bminHeight:\s*0\s*,/);
});
