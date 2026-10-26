import { t as translate, getLocale } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import { visit } from 'unist-util-visit';
import type { Root, PhrasingContent } from 'mdast';
import { autoLinkHref } from '../../utils/markdownLinks';
import { renderMarkdownRef, type MentionParticipant } from './markdownRefs';
import CodeBlock from './CodeBlock';
import { splitMarkdownFences } from '../../utils/markdownFences';
import { markdownMathRanges } from '../../utils/markdownMath';
import { ARTIFACT_TOKEN_RE } from '../../utils/artifactRef';
import { tokens } from '../../tokens';

export { handleMentionAwareCopy, type MentionParticipant } from './markdownRefs';

function markdownComponents(participants?: MentionParticipant[]): Components {
  return {
    a: ({ href, children }) => /^https?:\/\//i.test(href || '')
      ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: tokens.colors.accent }}>{children}</a>
      : <span>{children}</span>,
    span: ({ node, children, ...props }) => {
      const token = node?.properties?.['dataAwbRef'];
      return typeof token === 'string' ? <>{renderMarkdownRef(token, participants)}</> : <span {...props}>{children}</span>;
    },
    div: ({ node, children }) => {
      const code = node?.properties?.['dataCodeSource'];
      return typeof code === 'string'
        ? <CodeBlock code={code} language={String(node?.properties?.['dataCodeLanguage'] || '')} />
        : <div>{children}</div>;
    },
    pre: ({ children }) => <>{children}</>,
    table: ({ children }) => <div className="awb-markdown-table" tabIndex={0} role="region" aria-label={translate('표')}><table>{children}</table></div>,
    // Images/files use the authenticated preview path in SessionTranscript.
    img: ({ alt }) => <span>{alt}</span>,
  };
}

function prepareMarkdown(text: string) {
  let prefix = 'AWBMATH';
  while (text.includes(prefix)) prefix += 'X';
  const math = markdownMathRanges(text);
  let source = '';
  let cursor = 0;
  math.forEach((range, index) => {
    source += text.slice(cursor, range.start) + `${prefix}${index}END`;
    cursor = range.end;
  });
  source += text.slice(cursor);
  const fences = splitMarkdownFences(source).filter(segment => segment.kind === 'code');
  const restoreLiteral = (value: string) => value.replace(new RegExp(`${prefix}(\\d+)END`, 'g'), (_, index) => {
    const range = math[Number(index)];
    return text.slice(range.start, range.end);
  });
  const special = new RegExp(`${prefix}(\\d+)END|@\\[(?:user|agent|role|ticket):[\\w-]+(?:\\|[^\\]]*)?\\]|${ARTIFACT_TOKEN_RE.source}|@[a-zA-Z0-9_-]+|https?:\\/\\/[^\\s<>"']+`, 'g');
  function remarkContent() {
    return (tree: Root) => {
      // Nested/indented code and literal HTML can contain math-looking text too.
      // Restore source markers wherever Markdown treats content as literal data.
      visit(tree, node => {
        if (node.type === 'inlineCode' || node.type === 'html') node.value = restoreLiteral(node.value);
        if (node.type === 'link' || node.type === 'definition' || node.type === 'image') {
          node.url = restoreLiteral(node.url);
          if (node.title) node.title = restoreLiteral(node.title);
          if (node.type === 'image' && node.alt) node.alt = restoreLiteral(node.alt);
        }
      });
      visit(tree, 'code', node => {
        const fence = fences.find(segment => segment.start === node.position?.start.offset);
        node.data = { hName: 'div', hProperties: { className: [], dataCodeSource: restoreLiteral(fence?.code ?? node.value), dataCodeLanguage: node.lang || '' } };
      });
      visit(tree, 'link', (node, index, parent) => {
        // GFM includes adjacent Korean prose after an unmatched ')' in bare URLs.
        // mdast URI normalization percent-encodes IPv6 host brackets; keep the
        // original authority (the React link component still validates its scheme).
        if (/^https?:\/\/\[[\da-f:%.]+\]/i.test(node.url)) node.data = { hProperties: { href: node.url } };
        const raw = node.position
          ? source.slice(node.position.start.offset, node.position.end.offset)
          : node.children.length === 1 && node.children[0].type === 'text' ? node.children[0].value : '';
        if (!parent || index === undefined || !/^https?:\/\//.test(raw)) return;
        const href = autoLinkHref(raw);
        if (href === raw) return;
        node.url = href;
        node.children = [{ type: 'text', value: href }];
        parent.children.splice(index + 1, 0, { type: 'text', value: raw.slice(href.length) });
        return index + 2;
      });
      visit(tree, 'text', (node, index, parent) => {
        if (!parent || index === undefined) return;
        const children: PhrasingContent[] = [];
        let cursor = 0;
        special.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = special.exec(node.value))) {
          if (match[1] === undefined && (parent.type === 'link' || parent.type === 'linkReference')) continue;
          if (match.index! > cursor) children.push({ type: 'text', value: node.value.slice(cursor, match.index) });
          if (/^https?:\/\//.test(match[0])) {
            const href = autoLinkHref(match[0]);
            children.push({ type: 'text', value: href, data: { hName: 'a', hProperties: { href }, hChildren: [{ type: 'text', value: href }] } });
            cursor = match.index + href.length;
            special.lastIndex = cursor;
            continue;
          }
          const range = match[1] === undefined ? undefined : math[Number(match[1])];
          const value = range ? (range.closed ? range.value : text.slice(range.start, range.end)) : match[0];
          children.push({ type: 'text', value, data: {
            hName: 'span',
            hProperties: range
              ? { className: range.closed ? [range.display ? 'math-display' : 'math-inline'] : ['math-pending'] }
              : { dataAwbRef: value },
            hChildren: [{ type: 'text', value }],
          } });
          cursor = match.index! + match[0].length;
        }
        if (!children.length) return;
        if (cursor < node.value.length) children.push({ type: 'text', value: node.value.slice(cursor) });
        parent.children.splice(index, 1, ...children);
        return index + children.length;
      });
    };
  }
  return { source, remarkContent };
}

/** Shared Markdown for sessions, chat, tickets, mission conversations and memory. Raw HTML is
 * never executed; KaTeX also keeps trust disabled for agent-authored formulas.
 */
export default function Markdown({ text, participants }: { text: string; participants?: MentionParticipant[] }) {
  useLocale();
  const { source, remarkContent } = useMemo(() => prepareMarkdown(text), [text, getLocale()]);
  const components = useMemo(() => markdownComponents(participants), [participants, getLocale()]);
  return <div className="awb-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkContent]}
      rehypePlugins={[[rehypeKatex, { trust: false, strict: false, maxExpand: 1000, maxSize: 20 }]]}
      components={components}>{source}</ReactMarkdown>
  </div>;
}

/** Function entry point for existing text surfaces; uses the same component. */
export function renderMarkdown(text: string, participants?: MentionParticipant[]): React.ReactNode[] {
  return text ? [<Markdown key="markdown" text={text} participants={participants} />] : [];
}
