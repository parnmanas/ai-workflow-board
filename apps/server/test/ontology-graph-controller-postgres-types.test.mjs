import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const controllerPath = path.resolve(here, '../src/modules/ontology/ontology.controller.ts');
const source = fs.readFileSync(controllerPath, 'utf8');

test('graph edge subquery compares varchar edge endpoints with varchar node ids', () => {
  assert.match(
    source,
    /createQueryBuilder\('selected_node'\)[\s\S]*?\.select\('CAST\(selected_node\.id AS varchar\)'\)/,
    'PostgreSQL rejects ontology_edges.src_id/dst_id (varchar) IN a raw OntologyNode.id (uuid) subquery',
  );
});
