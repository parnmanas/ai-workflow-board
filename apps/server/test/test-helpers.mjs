// test-helpers.mjs — shared utilities for workspace isolation (leak) tests
//
// Usage pattern:
//   import { apiRequest, loginAs, createTestUser, createTestWorkspace, assignToWorkspace, approveUser } from './test-helpers.mjs';
//
// These helpers support the leak test suite (tickets-leak, channels-leak, api-keys-leak, agents-leak).
// Each leak test boots a NestJS app in-process and uses these helpers to set up multi-tenant scenarios.

export const BASE_URL_KEY = 'TEST_SERVER_URL'; // overridden per test via LEAK_TEST_PORT env

/**
 * Build a base URL from the current test port.
 * Tests set process.env.LEAK_TEST_PORT before importing helpers is not needed;
 * instead pass baseUrl explicitly to each helper that needs it.
 */
export function makeBaseUrl(port) {
  return `http://localhost:${port}`;
}

/**
 * Make an authenticated API request with optional X-Workspace-Id header.
 *
 * @param {string} baseUrl - Server base URL e.g. 'http://localhost:7793'
 * @param {string} path - API path without /api prefix, e.g. '/auth/login'
 * @param {object} opts
 * @param {string} [opts.token] - Bearer token
 * @param {string} [opts.workspaceId] - Workspace ID for X-Workspace-Id header
 * @param {string} [opts.method='GET'] - HTTP method
 * @param {object} [opts.body] - Request body (will be JSON stringified)
 */
export async function apiRequest(baseUrl, path, { token, workspaceId, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId;

  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

/**
 * Login and return the session token.
 *
 * @param {string} baseUrl
 * @param {string} email
 * @param {string} password
 * @returns {Promise<string|null>}
 */
export async function loginAs(baseUrl, email, password) {
  const { data } = await apiRequest(baseUrl, '/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  return data?.token || null;
}

/**
 * Create a workspace via admin token.
 * Returns the workspace object { id, name, ... }.
 *
 * @param {string} baseUrl
 * @param {string} adminToken
 * @param {string} name - Workspace name
 * @returns {Promise<object|null>}
 */
export async function createTestWorkspace(baseUrl, adminToken, name) {
  const { data, status } = await apiRequest(baseUrl, '/workspaces', {
    token: adminToken,
    method: 'POST',
    body: { name, description: 'Leak test workspace' },
  });
  if (status !== 201) {
    throw new Error(`createTestWorkspace failed (${status}): ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Create a user via admin users endpoint.
 * The user is created with status 'active' if password is provided and role != 'pending'.
 *
 * @param {string} baseUrl
 * @param {string} adminToken
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.email
 * @param {string} opts.password
 * @param {string} [opts.role='user']
 * @returns {Promise<object>}
 */
export async function createTestUser(baseUrl, adminToken, { name, email, password, role = 'user' }) {
  const { data, status } = await apiRequest(baseUrl, '/users', {
    token: adminToken,
    method: 'POST',
    body: { name, email, password, role },
  });
  if (status !== 201) {
    throw new Error(`createTestUser failed (${status}): ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Approve a pending user (admin only).
 *
 * @param {string} baseUrl
 * @param {string} adminToken
 * @param {string} userId
 */
export async function approveUser(baseUrl, adminToken, userId) {
  const { data, status } = await apiRequest(baseUrl, `/admin/pending-users/${userId}/approve`, {
    token: adminToken,
    method: 'POST',
  });
  if (status !== 200) {
    throw new Error(`approveUser failed (${status}): ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Assign a user to a workspace via ReBAC grant (admin only).
 *
 * @param {string} baseUrl
 * @param {string} adminToken
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} [relation='member']
 */
export async function assignToWorkspace(baseUrl, adminToken, userId, workspaceId, relation = 'member') {
  const { data, status } = await apiRequest(baseUrl, `/admin/pending-users/${userId}/assign`, {
    token: adminToken,
    method: 'POST',
    body: { workspace_id: workspaceId, relation },
  });
  if (status !== 200) {
    throw new Error(`assignToWorkspace failed (${status}): ${JSON.stringify(data)}`);
  }
  return data;
}
