import type { HostModelsView } from './hostModels';

export interface HostEffortReport {
  model: string | null;
  config_id: string | null;
  options: Array<{ value: string; label: string }>;
}

/** Do not reuse another model's effort levels, including for an unspecified CLI default. */
export function hostEffortReport(view: HostModelsView | null, cli: string, model: string | null): HostEffortReport | null {
  return view?.effort_options?.[cli]?.find((report) => report.model === model) ?? null;
}
