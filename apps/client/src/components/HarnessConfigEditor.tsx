import React, { useEffect, useState } from 'react';
import { HarnessConfig } from '../types';
import { tokens } from '../tokens';
import { Button, Input, Select } from './common';

// Agent harness editor (ticket 7122600c). Shared between Board Settings
// (per-board override) and Workspace Settings (workspace default) — the two
// surfaces edit the same HarnessConfig shape, only the save target differs.
// The raw harness_config JSON string from the server is parsed here; saving
// hands the structured object (or null when every field is empty) to the
// caller, which PATCHes it and re-fetches. Server-side zod is the validation
// authority — this component only normalises input shapes (tool lists are
// entered one-per-line / comma-separated and parsed to string[]).

interface HarnessConfigEditorProps {
  /** Raw harness_config JSON string from the Board / Workspace row. */
  raw: string | null | undefined;
  title: string;
  description: React.ReactNode;
  onSave(next: HarnessConfig | null): Promise<void>;
}

// Permission modes the claude CLI accepts today. The select also keeps an
// unknown stored value selectable (forward-compat — the server stores free
// text) by appending it to the options at render time.
const PERMISSION_MODE_OPTIONS = [
  { value: '', label: '(inherit / unset)' },
  { value: 'default', label: 'default' },
  { value: 'plan', label: 'plan' },
  { value: 'acceptEdits', label: 'acceptEdits' },
  { value: 'bypassPermissions', label: 'bypassPermissions' },
];

export function parseHarnessConfigRaw(raw: string | null | undefined): HarnessConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const toolsToText = (tools: string[] | undefined): string => (tools ?? []).join('\n');

// One tool per line; commas also split so a pasted "Read, Edit, Bash(*)"
// works. Blank entries drop out.
const textToTools = (text: string): string[] | undefined => {
  const items = text
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  return items.length > 0 ? items : undefined;
};

export default function HarnessConfigEditor({ raw, title, description, onSave }: HarnessConfigEditorProps) {
  const initial = parseHarnessConfigRaw(raw);
  const [systemPrompt, setSystemPrompt] = useState(initial.system_prompt_append ?? '');
  const [allowedTools, setAllowedTools] = useState(toolsToText(initial.allowed_tools));
  const [disallowedTools, setDisallowedTools] = useState(toolsToText(initial.disallowed_tools));
  const [model, setModel] = useState(initial.model ?? '');
  const [permissionMode, setPermissionMode] = useState(initial.permission_mode ?? '');
  const [busy, setBusy] = useState(false);

  // Re-sync when the row refreshes (e.g. saved from another tab).
  useEffect(() => {
    const next = parseHarnessConfigRaw(raw);
    setSystemPrompt(next.system_prompt_append ?? '');
    setAllowedTools(toolsToText(next.allowed_tools));
    setDisallowedTools(toolsToText(next.disallowed_tools));
    setModel(next.model ?? '');
    setPermissionMode(next.permission_mode ?? '');
  }, [raw]);

  const buildConfig = (): HarnessConfig | null => {
    const next: HarnessConfig = {};
    if (systemPrompt.trim().length > 0) next.system_prompt_append = systemPrompt;
    const allowed = textToTools(allowedTools);
    if (allowed) next.allowed_tools = allowed;
    const disallowed = textToTools(disallowedTools);
    if (disallowed) next.disallowed_tools = disallowed;
    if (model.trim().length > 0) next.model = model.trim();
    if (permissionMode.trim().length > 0) next.permission_mode = permissionMode.trim();
    return Object.keys(next).length > 0 ? next : null;
  };

  const dirty = JSON.stringify(buildConfig()) !== JSON.stringify(
    Object.keys(initial).length > 0 ? normalize(initial) : null,
  );

  const permissionOptions = PERMISSION_MODE_OPTIONS.some(o => o.value === permissionMode)
    ? PERMISSION_MODE_OPTIONS
    : [...PERMISSION_MODE_OPTIONS, { value: permissionMode, label: `${permissionMode} (custom)` }];

  const textareaStyle: React.CSSProperties = {
    width: '100%',
    background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    padding: '8px 10px',
    color: tokens.colors.textStrong,
    fontSize: 13,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
    resize: 'vertical',
  };

  const fieldLabelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    color: tokens.colors.textMuted,
    marginBottom: 4,
    textTransform: 'uppercase',
    fontWeight: 600,
  };

  return (
    <section
      style={{
        padding: 16,
        marginBottom: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        {title}
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        {description}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={fieldLabelStyle}>System prompt append</label>
          <textarea
            rows={4}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Extra system prompt merged into the subagent's --append-system-prompt"
            style={textareaStyle}
          />
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <label style={fieldLabelStyle}>Allowed tools</label>
            <textarea
              rows={3}
              value={allowedTools}
              onChange={(e) => setAllowedTools(e.target.value)}
              placeholder={'One per line (or comma-separated)\ne.g. Read\nBash(npm run build)'}
              style={textareaStyle}
            />
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <label style={fieldLabelStyle}>Disallowed tools</label>
            <textarea
              rows={3}
              value={disallowedTools}
              onChange={(e) => setDisallowedTools(e.target.value)}
              placeholder={'One per line (or comma-separated)\ne.g. WebSearch'}
              style={textareaStyle}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ width: 260 }}>
            <Input
              label="Model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. claude-sonnet-4-6 (empty = inherit)"
            />
          </div>
          <div style={{ width: 220 }}>
            <Select
              label="Permission mode"
              value={permissionMode}
              options={permissionOptions}
              onChange={(e) => setPermissionMode(e.target.value)}
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || busy}
            onClick={async () => {
              if (!dirty) return;
              setBusy(true);
              try {
                await onSave(buildConfig());
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </section>
  );
}

// Mirror of the editor's empty-field dropping so the dirty check compares
// like with like (a stored config with an empty-string field should not make
// the form permanently dirty).
function normalize(value: HarnessConfig): HarnessConfig | null {
  const next: HarnessConfig = {};
  if (value.system_prompt_append && value.system_prompt_append.trim().length > 0) {
    next.system_prompt_append = value.system_prompt_append;
  }
  if (value.allowed_tools && value.allowed_tools.length > 0) next.allowed_tools = value.allowed_tools;
  if (value.disallowed_tools && value.disallowed_tools.length > 0) next.disallowed_tools = value.disallowed_tools;
  if (value.model && value.model.trim().length > 0) next.model = value.model.trim();
  if (value.permission_mode && value.permission_mode.trim().length > 0) next.permission_mode = value.permission_mode.trim();
  return Object.keys(next).length > 0 ? next : null;
}
