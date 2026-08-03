import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(os.tmpdir(), `awb-prompt-reset-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.MCP_DEV_MODE = 'true';
process.env.AGENT_DEV_MODE = 'true';

describe('workspace built-in prompt reset', () => {
  let app;
  let ds;
  let service;
  let workspace;
  let board;
  let inProgressColumn;
  let customColumn;

  before(async () => {
    const { NestFactory } = await import('@nestjs/core');
    const { getDataSourceToken } = await import('@nestjs/typeorm');
    const { AppModule } = await import('../dist/app.module.js');
    const { PromptTemplatesService } = await import('../dist/modules/prompt-templates/prompt-templates.service.js');
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    ds = app.get(getDataSourceToken());
    service = app.get(PromptTemplatesService);

    const workspaceRepo = ds.getRepository('Workspace');
    workspace = await workspaceRepo.save(workspaceRepo.create({ name: 'Prompt reset workspace' }));
    const boardRepo = ds.getRepository('Board');
    board = await boardRepo.save(boardRepo.create({ workspace_id: workspace.id, name: 'Reset board' }));
    const columnRepo = ds.getRepository('BoardColumn');
    inProgressColumn = await columnRepo.save(columnRepo.create({
      workspace_id: workspace.id, board_id: board.id, name: 'In Progress', position: 0,
    }));
    customColumn = await columnRepo.save(columnRepo.create({
      workspace_id: workspace.id, board_id: board.id, name: 'Customer Sign-off', position: 1,
    }));
  });

  after(async () => {
    await app?.close();
  });

  it('publishes the built-in defaults catalog with stable column matches', () => {
    const catalog = service.getDefaultsCatalog();
    assert.equal(catalog.length, 7);
    assert.equal(catalog.find(row => row.name === 'in_progress_workflow')?.column_match, 'in progress');
    assert.ok(catalog.every(row => row.content && row.description && row.category));
  });

  it('resets one built-in in place without changing custom templates', async () => {
    const seeded = await service.seedDefaults(workspace.id);
    const target = seeded.find(row => row.name === 'in_progress_workflow');
    target.content = 'workspace customization';
    await ds.getRepository('PromptTemplate').save(target);
    const custom = await ds.getRepository('PromptTemplate').save(ds.getRepository('PromptTemplate').create({
      workspace_id: workspace.id,
      name: 'custom_workflow',
      description: 'Custom',
      content: 'Keep me',
      category: 'custom',
    }));

    await service.resetDefaults(workspace.id, ['in_progress_workflow'], false);

    const refreshed = await ds.getRepository('PromptTemplate').findOneByOrFail({ id: target.id });
    assert.equal(refreshed.id, target.id);
    assert.notEqual(refreshed.content, 'workspace customization');
    assert.equal((await ds.getRepository('PromptTemplate').findOneByOrFail({ id: custom.id })).content, 'Keep me');
  });

  it('full reset recreates missing defaults and repairs matching board mappings only', async () => {
    const templateRepo = ds.getRepository('PromptTemplate');
    const custom = await templateRepo.findOneByOrFail({ workspace_id: workspace.id, name: 'custom_workflow' });
    const missing = await templateRepo.findOneByOrFail({ workspace_id: workspace.id, name: 'review_workflow' });
    await templateRepo.delete({ id: missing.id });
    board.column_prompts = JSON.stringify({
      [inProgressColumn.id]: custom.id,
      [customColumn.id]: custom.id,
    });
    await ds.getRepository('Board').save(board);

    const names = service.getDefaultsCatalog().map(row => row.name);
    await service.resetDefaults(workspace.id, names, true);

    const recreated = await templateRepo.findOneBy({ workspace_id: workspace.id, name: 'review_workflow' });
    assert.ok(recreated);
    const inProgress = await templateRepo.findOneByOrFail({ workspace_id: workspace.id, name: 'in_progress_workflow' });
    const refreshedBoard = await ds.getRepository('Board').findOneByOrFail({ id: board.id });
    const mappings = JSON.parse(refreshedBoard.column_prompts);
    assert.equal(mappings[inProgressColumn.id], inProgress.id);
    assert.equal(mappings[customColumn.id], custom.id);
  });

  it('rejects unknown reset targets before changing persisted templates', async () => {
    const beforeRows = await ds.getRepository('PromptTemplate').findBy({ workspace_id: workspace.id });
    await assert.rejects(
      service.resetDefaults(workspace.id, ['not_a_builtin'], true),
      /Unknown built-in prompt template/,
    );
    const afterRows = await ds.getRepository('PromptTemplate').findBy({ workspace_id: workspace.id });
    assert.deepEqual(
      afterRows.map(row => [row.id, row.name, row.content]).sort(),
      beforeRows.map(row => [row.id, row.name, row.content]).sort(),
    );
  });
});
