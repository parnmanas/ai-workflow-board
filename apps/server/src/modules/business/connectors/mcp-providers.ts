import { BadRequestException } from '@nestjs/common';
import type { ConnectorDescriptor } from '../business.types';

/**
 * Providers that publish their own customer-facing remote MCP server. AWB signs in with the
 * owner's provider account (OAuth + PKCE) and relays tool calls; no partner contract or API key.
 *
 * `client` follows what the provider's authorization server actually accepts (checked 2026-10-29):
 * - doola: open Dynamic Client Registration, so AWB registers its own public client.
 * - Northwest: Keycloak rejects anonymous registration ("Trusted Hosts"). Its documented public
 *   client `mcp-connector` only accepts claude.ai/chatgpt.com and `http://localhost:<port>/…`
 *   redirects, so the owner pastes the final localhost address back into AWB.
 */
export interface McpProviderSpec {
  url: string;
  /** Every OAuth endpoint the discovery documents announce must live on one of these origins. */
  auth_origins: string[];
  scope: string;
  client: { kind: 'dynamic' } | { kind: 'public'; client_id: string; loopback_only: true };
  /**
   * Tools that charge a saved payment method or enrol it in autopay. Never relayed; the owner finishes
   * them in the provider. Matched with or without a client prefix (`v2_client__checkout_cart_tool`).
   * Everything else that is not annotated read-only still needs an explicit `confirm`.
   */
  owner_only_tools: string[];
}
export interface McpBusinessConnectorDescriptor extends ConnectorDescriptor { mode: 'mcp'; mcp: McpProviderSpec }

/** Paste-back address for providers whose public client only allows loopback redirects. */
export const MCP_LOOPBACK_REDIRECT = 'http://localhost:47913/awb/oauth/callback';

const mcp = (descriptor: Omit<McpBusinessConnectorDescriptor, 'mode' | 'fields' | 'secret_fields' | 'environments' | 'monogram'> & { monogram: string }): { descriptor: McpBusinessConnectorDescriptor } =>
  ({ descriptor: { ...descriptor, mode: 'mcp', fields: [], secret_fields: [], environments: [] } });

export const MCP_CONNECTORS = [
  mcp({
    id: 'doola', name: 'doola', stage: 'formation', color: '#facc15', monogram: 'd',
    summary: '대화형 LLC 설립 · EIN · 등록 대리인', capabilities: ['doola 계정 로그인', 'LLC 설립 진행 (MCP)', '설립 · 서류 상태 조회'],
    setup_note: 'doola 고객 계정으로 로그인하면 에이전트가 doola MCP로 설립 정보를 입력하고 진행 상태를 확인합니다. 결제와 본인 서명은 doola 화면에서 소유자가 직접 진행합니다.',
    docs_url: 'https://www.doola.com/blog/doola-mcp-form-your-llc-inside-ai-chat/', portal_url: 'https://app.doola.com',
    mcp: { url: 'https://mcp.doola.com', auth_origins: ['https://mcp.doola.com', 'https://dds.doola.com'], scope: '', client: { kind: 'dynamic' }, owner_only_tools: [] },
  }),
  mcp({
    id: 'northwest', name: 'Northwest Registered Agent', stage: 'formation', color: '#38bdf8', monogram: 'N',
    summary: '설립 · 등록 대리인 · 연차 보고 · 우편 스캔', capabilities: ['Northwest 계정 로그인', '회사 · 신고 · 청구서 조회 (MCP)', '장바구니 준비 (MCP)'],
    setup_note: 'Northwest 고객 계정으로 로그인하면 에이전트가 Northwest MCP로 회사·신고·서류·청구서를 조회하고 신청 장바구니를 준비합니다. 결제(체크아웃)는 Northwest 화면에서 소유자가 직접 진행합니다.',
    docs_url: 'https://www.northwestregisteredagent.com/ai/mcp', portal_url: 'https://www.northwestregisteredagent.com/login',
    mcp: { url: 'https://mcp.northwestregisteredagent.com/', auth_origins: ['https://mcp.northwestregisteredagent.com', 'https://id.northwestregisteredagent.com'], scope: 'openid profile email',
      client: { kind: 'public', client_id: 'mcp-connector', loopback_only: true },
      // Northwest checks out against a card already on file (tools catalogue, 2026-10-22).
      owner_only_tools: ['checkout_cart_tool', 'pay_invoice_tool', 'enable_autopay_tool', 'purchase_compliance_service_tool'] },
  }),
] as const;

export const isOwnerOnlyTool = (spec: McpProviderSpec, name: string) => spec.owner_only_tools.some(t => name === t || name.endsWith(`__${t}`));

export function mcpConnector(id: string): McpBusinessConnectorDescriptor {
  const found = MCP_CONNECTORS.find(c => c.descriptor.id === id);
  if (!found) throw new BadRequestException('MCP로 연결하는 서비스가 아닙니다.');
  return found.descriptor;
}
