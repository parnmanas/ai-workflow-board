import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { publicBaseUrl } from '../../common/public-url';
import { decryptStrict, encrypt } from '../../services/encryption.service';

export function oauthBase() {
  const base = publicBaseUrl();
  if (!base) return '';
  const url = new URL(base);
  return url.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ? base : '';
}

function connector(uri: string) {
  if (uri === 'https://claude.ai/api/mcp/auth_callback') return 'Claude';
  if (uri === 'https://chatgpt.com/connector_platform_oauth_redirect'
      || /^https:\/\/chatgpt\.com\/connector\/oauth\/[a-zA-Z0-9_-]{1,160}$/.test(uri)
      || uri === 'https://platform.openai.com/apps-manage/oauth') return 'ChatGPT';
  const extra = (process.env.MCP_OAUTH_REDIRECT_URIS || '').split(',').map(s => s.trim());
  if (uri && extra.includes(uri) && URL.canParse(uri)) {
    const url = new URL(uri);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) return url.origin;
  }
  return '';
}

// DCR is public. A sealed registration persists across restarts without allowing anonymous
// callers to allocate database rows or choose a redirect after the registration was issued.
export const mcpClients: OAuthRegisteredClientsStore = {
  registerClient(input) {
    const uris = input.redirect_uris;
    const name = connector(uris[0]);
    const method = input.token_endpoint_auth_method || 'client_secret_post';
    if (!oauthBase() || !name || uris.length > 8 || !uris.every(uri => connector(uri) === name)
        || !['none', 'client_secret_post'].includes(method)) {
      throw new InvalidClientMetadataError('Use a supported connector callback and PKCE with none or client_secret_post authentication.');
    }
    const client = {
      client_name: name, redirect_uris: uris, token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], client_secret: input.client_secret, client_secret_expires_at: input.client_secret_expires_at,
    };
    const sealed = encrypt(JSON.stringify({ purpose: 'awb-mcp-client-v1', issuer: oauthBase(), client }));
    const registration = Buffer.from(sealed.slice(4), 'base64').toString('base64url');
    if (registration.length > 4096) throw new InvalidClientMetadataError('The callback list is too long.');
    return { ...client, client_id: 'awbc_' + registration };
  },
  getClient(client_id): OAuthClientInformationFull | undefined {
    if (!/^awbc_[\w-]{1,4096}$/.test(client_id)) return;
    try {
      const value = JSON.parse(decryptStrict('enc:' + Buffer.from(client_id.slice(5), 'base64url').toString('base64')));
      if (value.purpose === 'awb-mcp-client-v1' && value.issuer === oauthBase()
          && value.client.redirect_uris.every((uri: string) => connector(uri) === value.client.client_name)) {
        return { ...value.client, client_id };
      }
    } catch { /* Invalid or retired registration. */ }
  },
};
