/** ACP configuration belongs to the currently selected model, not every model in its list. */
export interface HostEffortReport {
  model: string | null;
  config_id: string | null;
  options: Array<{ value: string; label: string }>;
}

export function effortReportFromConfigOptions(raw: unknown): HostEffortReport | null {
  let options: any;
  try { options = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!Array.isArray(options) || !options.length) return null;
  const model = options.find((o) => o?.category === 'model');
  const effort = options.find((o) => o?.category === 'thought_level' && o.type === 'select');
  const choices: HostEffortReport['options'] = [];
  const seen = new Set<string>();
  for (const choice of Array.isArray(effort?.options) ? effort.options : []) {
    if (typeof choice?.value !== 'string' || !choice.value || seen.has(choice.value)) continue;
    seen.add(choice.value);
    choices.push({ value: choice.value, label: typeof choice.name === 'string' && choice.name ? choice.name : choice.value });
  }
  return {
    model: typeof model?.current_value === 'string' && model.current_value ? model.current_value : null,
    config_id: typeof effort?.config_id === 'string' ? effort.config_id : null,
    options: choices,
  };
}
