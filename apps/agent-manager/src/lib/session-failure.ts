/** Whitelisted facts from a CLI's native failure record. Never relay raw headers/body. */
export interface SessionFailureDetails {
  status?: number;
  provider?: string;
  model?: string;
  providerCode?: string;
  parameter?: string;
  message?: string;
  previousTokens?: number;
  compactCommand?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 600) : undefined;
}

export function sessionFailureDetails(value: unknown): SessionFailureDetails {
  const data = record(value);
  const nested = record(data.error);
  return {
    status: typeof data.statusCode === 'number' ? data.statusCode : undefined,
    providerCode: text(nested.code) ?? text(data.code) ?? text(nested.type) ?? text(data.errorName),
    parameter: text(nested.param) ?? text(data.param),
    message: text(nested.message) ?? text(data.message),
  };
}

/** Adds evidence and actionable advice without treating an ambiguous HTTP 400 as a diagnosis. */
export function describeSessionFailure(error: { message?: string; rpcCode?: number; data?: unknown }, native?: SessionFailureDetails | null): string {
  const rpc = sessionFailureDetails(error.data);
  const details = native ?? rpc;
  const original = String(error.message || 'The session request failed.').slice(0, 2_000);
  const lines = [original];
  const facts = [
    details.status ? `HTTP ${details.status}` : '',
    details.provider && details.model ? `Model: ${details.provider}/${details.model}` : '',
    details.providerCode ? `Provider code: ${details.providerCode}` : '',
    details.parameter ? `Parameter: ${details.parameter}` : '',
    error.rpcCode !== undefined ? `ACP code: ${error.rpcCode}` : '',
  ].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '));
  if (details.message && !original.includes(details.message)) lines.push(`Provider: ${details.message}`);
  if (details.previousTokens && details.previousTokens > 0) {
    lines.push(`Last successful request: ${details.previousTokens.toLocaleString('en-US')} tokens (including cached tokens; not the failed request's size).`);
  }
  const reason = `${original} ${details.message ?? ''} ${details.providerCode ?? ''}`;
  const compact = details.compactCommand ? `Send ${details.compactCommand} in this session, or start a new session.` : 'Compact the conversation if supported, or start a new session.';
  if (details.status === 401 || details.status === 403) {
    lines.push('Check this Runtime Host’s CLI credential, login status, and access to the selected model.');
  } else if (details.status === 429) {
    lines.push('The provider rejected the request due to a rate or quota limit. Check the provider’s usage limits and billing before retrying.');
  } else if (details.status && details.status >= 500) {
    lines.push('The provider reported a server error. Retry later or check its service status.');
  } else if (/context_length_exceeded|context_window_exceeded|maximum context|context.{0,30}(exceed|too long)|too many tokens/i.test(reason)) {
    lines.push(`The provider reports that the conversation exceeds its context limit. ${compact}`);
  } else if (details.status === 400 || /invalid parameters|invalid_request_error/i.test(reason)) {
    lines.push('The provider rejected the request. This error alone does not establish which limit or parameter failed.');
    if (details.parameter) lines.push(`Check the reported parameter (${details.parameter}) in the model settings or request.`);
    else lines.push(`Possible causes include a long conversation or unsupported model settings/attachments. For a long conversation, ${compact.charAt(0).toLowerCase()}${compact.slice(1)} If a new session also fails, check the model settings and attachments.`);
  }
  return lines.join('\n');
}
