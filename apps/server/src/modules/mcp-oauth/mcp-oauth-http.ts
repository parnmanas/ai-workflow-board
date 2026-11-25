import type { INestApplication } from '@nestjs/common';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import type { NextFunction, Request, Response } from 'express';
import { mcpClients, oauthBase } from './mcp-oauth-clients';
import { McpOAuthService, oauthScopes } from './mcp-oauth.service';

const resourceMetadata = '/.well-known/oauth-protected-resource';
const issuerMetadata = '/.well-known/oauth-authorization-server';

export function applyMcpOAuth(app: INestApplication) {
  const provider = app.get(McpOAuthService);
  const express = app.getHttpAdapter().getInstance();
  const path = '/api/mcp-oauth';
  const publicMetadata = (res: Response) => res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  express.get(resourceMetadata + '{/*suffix}', (req: Request, res: Response) => {
    const base = oauthBase();
    if (!base) return res.sendStatus(503);
    const prefix = new URL(base).pathname.replace(/\/$/, '');
    if (![resourceMetadata, resourceMetadata + '/mcp', resourceMetadata + prefix + '/mcp'].includes(req.path)) return res.sendStatus(404);
    return publicMetadata(res).json({ resource: base + '/mcp', authorization_servers: [base], scopes_supported: oauthScopes,
      bearer_methods_supported: ['header'], resource_name: 'AWB', resource_documentation: base + '/settings/mcp' });
  });
  express.get(issuerMetadata + '{/*suffix}', (req: Request, res: Response) => {
    const base = oauthBase();
    if (!base) return res.sendStatus(503);
    const prefix = new URL(base).pathname.replace(/\/$/, '');
    if (req.path !== issuerMetadata && req.path !== issuerMetadata + prefix) return res.sendStatus(404);
    return publicMetadata(res).json({ issuer: base, authorization_endpoint: base + path + '/authorize', token_endpoint: base + path + '/token',
      registration_endpoint: base + path + '/register', revocation_endpoint: base + path + '/revoke', scopes_supported: oauthScopes,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'], revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'] });
  });
  // The SDK constructs its own error redirect after validating the client and callback.
  // Include RFC 9207's issuer on those responses as well as on the consent decision.
  express.use(path + '/authorize', (_req: Request, res: Response, next: NextFunction) => {
    const location = res.location.bind(res);
    res.location = (destination: string) => {
      const url = new URL(destination);
      if (url.searchParams.has('error')) url.searchParams.set('iss', oauthBase());
      return location(url.href);
    };
    next();
  }, authorizationHandler({ provider }));
  express.use(path + '/register', clientRegistrationHandler({ clientsStore: mcpClients, clientSecretExpirySeconds: 0 }));
  express.use(path + '/token', tokenHandler({ provider }));
  express.use(path + '/revoke', revocationHandler({ provider }));
}
