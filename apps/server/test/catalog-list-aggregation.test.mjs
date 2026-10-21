// The Functions / Credentials / Resources pages list every accessible
// Account's rows plus Global (`account_id NULL`) rows — docs/ownership.md:
// the page's default account is a creation default, never a list filter.
// They used to list "Global + the hidden current account" because
// AccountAccessService.bindRequest rewrites `query.account_id` to that default.
//
// An EXPLICIT account_id (req.requestedAccountId) keeps the single-Account
// view: credential pickers for CLI settings, projects and runtime slots, and
// the ticket resource picker, must only offer what that one Account can read.
//
// Controllers are instantiated directly (credentials-scope.test.mjs pattern);
// requests carry the fields bindRequest sets.

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { User } from '../dist/entities/User.js';
import { Account } from '../dist/entities/Account.js';
import { Credential } from '../dist/entities/Credential.js';
import { Resource } from '../dist/entities/Resource.js';
import { WorkflowFunction } from '../dist/entities/WorkflowFunction.js';
import { WorkflowFunctionRun } from '../dist/entities/WorkflowFunctionRun.js';
import { CredentialsController } from '../dist/modules/credentials/credentials.controller.js';
import { ResourcesController } from '../dist/modules/resources/resources.controller.js';
import { WorkflowFunctionsController } from '../dist/modules/workflow-functions/workflow-functions.controller.js';
import { WorkflowFunctionsService } from '../dist/modules/workflow-functions/workflow-functions.service.js';
import { AccountAccessService } from '../dist/services/account-access.service.js';
import { encrypt } from '../dist/services/encryption.service.js';

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const user = { id: 'u-member', name: 'Member', role: 'user', permissions: ['admin.credentials'] };

/** What AccountAccessService.bindRequest leaves on a request. */
function boundReq(accessible, requested = null) {
  return {
    currentUser: user,
    accountAccessBound: true,
    accessibleAccountIds: accessible,
    requestedAccountId: requested,
    // bindRequest also rewrites this to the default — it must not narrow the list.
    query: { account_id: accessible[0] },
  };
}

const ACCESSIBLE = ['account-a', 'account-b'];

describe('catalog lists aggregate accessible Accounts + Global', () => {
  let dataSource;
  let credentials;
  let resources;
  let functions;
  let functionsService;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [User, Account, Credential, Resource, WorkflowFunction, WorkflowFunctionRun],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();

    const credRepo = dataSource.getRepository(Credential);
    credentials = new CredentialsController(credRepo, dataSource, {}, {});
    resources = new ResourcesController(dataSource.getRepository(Resource), credRepo);
    functionsService = new WorkflowFunctionsService(dataSource, {
      dispatch: async () => { throw new Error('not used'); },
    });
    await functionsService.onModuleInit();
    functions = new WorkflowFunctionsController(functionsService);

    for (const [accountId, label] of [['account-a', 'A'], ['account-b', 'B'], ['account-c', 'C'], [null, 'Global']]) {
      await credRepo.save(credRepo.create({
        account_id: accountId,
        name: `${label} credential`,
        provider: label === 'B' ? 'openai' : 'github',
        encrypted_data: encrypt(JSON.stringify({ token: label })),
      }));
      await dataSource.getRepository(Resource).save(dataSource.getRepository(Resource).create({
        account_id: accountId,
        name: `${label} resource`,
        type: label === 'B' ? 'document' : 'link',
      }));
    }
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  describe('Credentials', () => {
    it('without an explicit account_id lists every accessible Account + Global, never an inaccessible one', async () => {
      const res = response();
      const req = boundReq(ACCESSIBLE);
      await credentials.list(req.query.account_id, undefined, undefined, undefined, res, req);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.map((row) => row.name), ['A credential', 'B credential', 'Global credential']);
      // Each row carries its owner so the page can name it.
      assert.deepEqual(res.body.map((row) => row.account_id), ['account-a', 'account-b', null]);
      assert.deepEqual(res.body.map((row) => row.scope), ['account', 'account', 'global']);
    });

    it('an explicit account_id keeps the single-Account view (credential pickers)', async () => {
      const res = response();
      const req = boundReq(ACCESSIBLE, 'account-b');
      await credentials.list('account-b', undefined, undefined, undefined, res, req);
      assert.deepEqual(res.body.map((row) => row.name), ['B credential', 'Global credential']);
    });

    it('keeps the provider filter and scope=global on the aggregated list', async () => {
      const filtered = response();
      const req = boundReq(ACCESSIBLE);
      await credentials.list(req.query.account_id, 'github', undefined, undefined, filtered, req);
      assert.deepEqual(filtered.body.map((row) => row.name), ['A credential', 'Global credential']);

      const globalsOnly = response();
      await credentials.list(req.query.account_id, undefined, 'global', undefined, globalsOnly, boundReq(ACCESSIBLE));
      assert.deepEqual(globalsOnly.body.map((row) => row.name), ['Global credential']);
    });

    it('a caller with no accessible Account sees Global rows only', async () => {
      const res = response();
      await credentials.list(undefined, undefined, undefined, undefined, res, boundReq([]));
      assert.deepEqual(res.body.map((row) => row.name), ['Global credential']);
    });
  });

  describe('Resources', () => {
    it('without an explicit account_id lists every accessible Account + Global, never an inaccessible one', async () => {
      const res = response();
      const req = boundReq(ACCESSIBLE);
      await resources.list(req.query.account_id, undefined, 'name', 'asc', undefined, res, req);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.map((row) => row.name), ['A resource', 'B resource', 'Global resource']);
      assert.deepEqual(res.body.map((row) => row.account_id), ['account-a', 'account-b', null]);
    });

    it('an explicit account_id keeps the single-Account view (ticket resource picker)', async () => {
      const res = response();
      await resources.list('account-a', undefined, 'name', 'asc', undefined, res, boundReq(ACCESSIBLE, 'account-a'));
      assert.deepEqual(res.body.map((row) => row.name), ['A resource', 'Global resource']);
    });

    it('keeps the type filter and sort on the aggregated list', async () => {
      const req = boundReq(ACCESSIBLE);
      const documents = response();
      await resources.list(req.query.account_id, 'document', 'name', 'asc', undefined, documents, req);
      assert.deepEqual(documents.body.map((row) => row.name), ['B resource']);

      const desc = response();
      await resources.list(req.query.account_id, undefined, 'name', 'desc', undefined, desc, req);
      assert.deepEqual(desc.body.map((row) => row.name), ['Global resource', 'B resource', 'A resource']);
    });

    it('a caller with no accessible Account sees Global rows only', async () => {
      const res = response();
      await resources.list(undefined, undefined, 'name', 'asc', undefined, res, boundReq([]));
      assert.deepEqual(res.body.map((row) => row.name), ['Global resource']);
    });
  });

  describe('Functions', () => {
    before(async () => {
      for (const accountId of ['account-a', 'account-b', 'account-c']) {
        await functionsService.create({
          account_id: accountId, key: `own.${accountId}`, name: `Own ${accountId}`, executor_type: 'builtin',
          config: { handler: 'system.noop' },
        });
      }
      // system.noop: overridden by A only — B still inherits the Global row.
      await functionsService.create({
        account_id: 'account-a', key: 'system.noop', name: 'A echo', executor_type: 'builtin',
        config: { handler: 'system.noop' },
      });
      // workflow.ticket_snapshot: overridden by every accessible Account.
      for (const accountId of ACCESSIBLE) {
        await functionsService.create({
          account_id: accountId, key: 'workflow.ticket_snapshot', name: `${accountId} snapshot`, executor_type: 'builtin',
          config: { handler: 'system.noop' },
        });
      }
    });

    const owners = (rows, key) => rows.filter((row) => row.key === key).map((row) => row.account_id).sort();

    it('the management view (include_shadowed) lists every accessible Account + Global, never an inaccessible one', async () => {
      const res = response();
      const req = boundReq(ACCESSIBLE);
      await functions.list(req.query.account_id, 'true', res, req);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.every((row) => row.account_id !== 'account-c'), 'account-c is not accessible');
      assert.deepEqual(owners(res.body, 'own.account-a'), ['account-a']);
      assert.deepEqual(owners(res.body, 'own.account-b'), ['account-b']);
      assert.deepEqual(owners(res.body, 'own.account-c'), []);
      assert.deepEqual(owners(res.body, 'system.noop'), ['account-a', null].sort());
      assert.deepEqual(owners(res.body, 'workflow.ticket_snapshot'), ['account-a', 'account-b', null].sort());
    });

    it('the resolved aggregate keeps a Global row while any accessible Account still inherits it', async () => {
      const res = response();
      const req = boundReq(ACCESSIBLE);
      await functions.list(req.query.account_id, undefined, res, req);
      // B inherits the Global system.noop, so it stays next to A's override.
      assert.deepEqual(owners(res.body, 'system.noop'), ['account-a', null].sort());
      // Every accessible Account overrides it — the Global row is shadowed everywhere.
      assert.deepEqual(owners(res.body, 'workflow.ticket_snapshot'), ['account-a', 'account-b']);
      // Untouched built-ins are still inherited.
      assert.deepEqual(owners(res.body, 'workflow.verify_children_complete'), [null]);
    });

    it('an explicit account_id keeps that Account’s resolved view', async () => {
      const res = response();
      await functions.list('account-b', undefined, res, boundReq(ACCESSIBLE, 'account-b'));
      assert.ok(res.body.every((row) => row.account_id === null || row.account_id === 'account-b'));
      assert.deepEqual(owners(res.body, 'system.noop'), [null]);
      assert.deepEqual(owners(res.body, 'workflow.ticket_snapshot'), ['account-b']);
    });

    it('recent runs aggregate accessible Accounts; an explicit account_id narrows them', async () => {
      const runs = dataSource.getRepository(WorkflowFunctionRun);
      const noop = (await functionsService.list(null)).find((row) => row.key === 'system.noop');
      for (const accountId of ['account-a', 'account-b', 'account-c']) {
        await runs.save(runs.create({
          function_id: noop.id, function_key: noop.key, function_version: 1, account_id: accountId, status: 'succeeded',
        }));
      }
      const req = boundReq(ACCESSIBLE);
      const all = response();
      await functions.listRuns(req.query.account_id, undefined, undefined, '50', all, req);
      assert.equal(all.statusCode, 200);
      assert.deepEqual(all.body.map((row) => row.account_id).sort(), ['account-a', 'account-b']);

      const one = response();
      await functions.listRuns('account-b', undefined, undefined, '50', one, boundReq(ACCESSIBLE, 'account-b'));
      assert.deepEqual(one.body.map((row) => row.account_id), ['account-b']);

      const none = response();
      await functions.listRuns(undefined, undefined, undefined, '50', none, boundReq([]));
      assert.deepEqual(none.body, []);
    });
  });

  // The fake requests above mirror bindRequest; pin the real one too — the
  // browser's X-Account-Id creation-default header and the rewritten
  // query.account_id must not turn into an explicit account filter.
  it('through AccountAccessService.bindRequest: the default-account header does not filter, an explicit account_id does', async () => {
    const admin = await dataSource.getRepository(User).save({ id: 'u-admin', name: 'Admin', email: 'catalog-admin@example.test', role: 'admin', status: 'active' });
    const accountRepo = dataSource.getRepository(Account);
    const [first, second] = [
      await accountRepo.save(accountRepo.create({ name: 'First', kind: 'personal', owner_user_id: admin.id })),
      await accountRepo.save(accountRepo.create({ name: 'Second', kind: 'organization', owner_user_id: admin.id })),
    ];
    const credRepo = dataSource.getRepository(Credential);
    for (const account of [first, second]) {
      await credRepo.save(credRepo.create({
        account_id: account.id, name: `${account.name} owned`, provider: 'github',
        encrypted_data: encrypt(JSON.stringify({ token: account.name })),
      }));
    }
    const access = new AccountAccessService(dataSource, {});

    const pageReq = { currentUser: admin, method: 'GET', path: '/api/credentials', query: {}, headers: { 'x-account-id': first.id } };
    await access.bindRequest(pageReq);
    assert.equal(pageReq.query.account_id, first.id, 'precondition: bindRequest rewrites the query to the default');
    const page = response();
    await credentials.list(pageReq.query.account_id, undefined, undefined, undefined, page, pageReq);
    const pageNames = page.body.map((row) => row.name);
    assert.ok(pageNames.includes('First owned') && pageNames.includes('Second owned'), JSON.stringify(pageNames));

    const pickerReq = { currentUser: admin, method: 'GET', path: '/api/credentials', query: { account_id: second.id }, headers: { 'x-account-id': first.id } };
    await access.bindRequest(pickerReq);
    const picker = response();
    await credentials.list(pickerReq.query.account_id, undefined, undefined, undefined, picker, pickerReq);
    assert.deepEqual(picker.body.map((row) => row.name), ['Global credential', 'Second owned']);
  });
});
