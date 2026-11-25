/** Legal/business tool arguments can contain addresses, correspondence and contract terms. */
export function mcpRequestPreview(body: any, accountApp = false): string | undefined {
  const preview = (value: any): any => {
    if (accountApp && value?.method === 'tools/call') {
      return { jsonrpc: value.jsonrpc, id: value.id, method: value.method, params: { name: value.params?.name, arguments: '[app arguments omitted]' } };
    }
    if (value?.method === 'tools/call' && value.params?.name === 'send_session_message') {
      return { jsonrpc: value.jsonrpc, id: value.id, method: value.method, params: { name: value.params.name, arguments: '[session message omitted]' } };
    }
    if (value?.method === 'tools/call' && typeof value.params?.name === 'string' && value.params.name.includes('business')) {
      return { jsonrpc: value.jsonrpc, id: value.id, method: value.method, params: { name: value.params.name, arguments: '[private business arguments omitted]' } };
    }
    return value;
  };
  return JSON.stringify(Array.isArray(body) ? body.map(preview) : preview(body))?.slice(0, 300);
}
