export interface BuiltinPromptDefault {
  name: string;
  description: string;
  content: string;
  category: string;
  column_match: string;
}

export type PromptTemplateResetDraft = Record<string, BuiltinPromptDefault>;

export function resetTemplateDraft(
  current: PromptTemplateResetDraft,
  definition: BuiltinPromptDefault,
): PromptTemplateResetDraft {
  return { ...current, [definition.name]: { ...definition } };
}

export function resetAllTemplateDrafts(
  current: PromptTemplateResetDraft,
  definitions: BuiltinPromptDefault[],
): PromptTemplateResetDraft {
  return definitions.reduce(resetTemplateDraft, { ...current });
}

export function resetColumnMappingDraft(
  current: Record<string, string>,
  column: { id: string; name: string },
  definitions: BuiltinPromptDefault[],
  templates: Array<{ id: string; name: string }>,
): Record<string, string> {
  const definition = definitions.find(
    row => row.column_match === String(column.name || '').trim().toLowerCase(),
  );
  if (!definition) return current;
  const template = templates.find(row => row.name === definition.name);
  if (!template) return current;
  return { ...current, [column.id]: template.id };
}

export function resetAllColumnMappingDrafts(
  current: Record<string, string>,
  columns: Array<{ id: string; name: string }>,
  definitions: BuiltinPromptDefault[],
  templates: Array<{ id: string; name: string }>,
): Record<string, string> {
  return columns.reduce(
    (draft, column) => resetColumnMappingDraft(draft, column, definitions, templates),
    { ...current },
  );
}
