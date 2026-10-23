import type { FormationConnector } from './connectors/formation-connector';
export const BUSINESS_STAGES = ['formation', 'trademark', 'banking', 'payments', 'accounting', 'support', 'growth'] as const;
export type BusinessStage = typeof BUSINESS_STAGES[number];
export type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'done';

export interface ConnectorMetric {
  label: string;
  value: string | number;
  currency?: string;
  amount_minor?: number;
}
export interface ConnectorRecord {
  id: string;
  label: string;
  status: string;
  date?: string;
  amount_minor?: number;
  currency?: string;
}
export interface ConnectorSnapshot {
  metrics: ConnectorMetric[];
  records: ConnectorRecord[];
  note: string;
}
export interface ConnectorField {
  key: string;
  label: string;
  placeholder: string;
}
export interface ConnectorDescriptor {
  id: string;
  name: string;
  stage: BusinessStage;
  color: string;
  monogram: string;
  mode: 'api' | 'handoff';
  summary: string;
  capabilities: string[];
  setup_note: string;
  docs_url: string;
  portal_url: string;
  credential_provider?: string;
  secret_fields: string[];
  fields: ConnectorField[];
  environments: Array<'live' | 'sandbox'>;
  offering?: ServiceOffering;
  formation?: { states: string[]; entity_types: string[] };
}
export interface ServiceOffering {
  best_for: string;
  features: string[];
  api_access: 'public' | 'partner' | 'unverified';
  api_note: string;
  external_steps: string[];
  pricing: {
    plans: Array<{ id: string; name: string; price: string; detail: string }>;
    extra: string;
    url: string;
    checked_at: string;
  };
}
export interface ConnectorContext {
  environment: 'live' | 'sandbox';
  config: Record<string, string>;
  secrets: Record<string, string>;
  get(path: string, headers: Record<string, string>): Promise<any>;
}
export interface BusinessConnector {
  descriptor: ConnectorDescriptor;
  formation?: FormationConnector;
  sync?: (context: ConnectorContext) => Promise<ConnectorSnapshot>;
}
