/**
 * Renders a stored mention preview as text a human can read.
 *
 * Mention previews are a raw `content.slice(0, 500)` snapshot taken at
 * dispatch time, so they still contain the structured tokens the composer
 * emits: `@[user:7f2c9a10-…|박민수] 이 부분 확인 부탁드립니다`. Chat and comment
 * views run that text through the markdown/pill renderer, but the mention
 * inbox row, the toast, and the OS notification body all print it as plain
 * text — which is why a mention notification showed a UUID mid-sentence.
 *
 * This is deliberately a text transform, not a React renderer: two of the
 * three call sites (Notification body, toast string) can only take a string.
 * The token grammar mirrors STRUCTURED_TOKEN_RE in chat/utils/markdown.tsx.
 */

const STRUCTURED_TOKEN_RE = /@\[(user|agent|role|ticket):([\w-]+)(?:\|([^\]]*))?\]/g;

// Fallback label per token type, used when the token carries no display name
// (older rows, or a programmatic mention). Showing the bare id would just be
// the UUID again, which is the thing we are removing.
const FALLBACK_LABEL: Record<string, string> = {
  user: '사용자',
  agent: '에이전트',
  role: '역할',
  ticket: '티켓',
};

export function renderMentionPreview(text: string | null | undefined): string {
  if (!text) return '';
  const replaced = text.replace(
    STRUCTURED_TOKEN_RE,
    (_full, type: string, id: string, displayName?: string) => {
      const name = (displayName || '').trim();
      // A role token's id IS the human-readable slug (e.g. "assignee"), so it
      // is a better fallback than the generic label. For user/agent/ticket the
      // id is a UUID and never worth showing.
      const label = name || (type === 'role' ? id : FALLBACK_LABEL[type] || type);
      return type === 'ticket' ? `#${label}` : `@${label}`;
    },
  );
  // Previews are rendered on a single clamped line; collapse newlines so a
  // multi-paragraph comment doesn't turn into a mostly-blank row.
  return replaced.replace(/\s+/g, ' ').trim();
}
