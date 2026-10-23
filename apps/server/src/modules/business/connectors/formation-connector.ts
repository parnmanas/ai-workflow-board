export interface FormationContext {
  environment: 'sandbox' | 'live';
  secrets: Record<string, string>;
  get(url: string, headers: Record<string, string>): Promise<any>;
  post(url: string, headers: Record<string, string>, body: unknown): Promise<any>;
}
export interface FormationReferences {
  industries: string[];
  fees: Array<{ state: string; price_in_cents: number }>;
}
export interface FormationRequest {
  customer: Record<string, unknown>;
  company: Record<string, unknown>;
  summary: { name: string; state: string; entity_type: string; industry: string };
}
export interface FormationConnector {
  references(context: FormationContext): Promise<FormationReferences>;
  prepare(input: unknown, references: FormationReferences): FormationRequest;
  customer(context: FormationContext, input: Record<string, unknown>, key: string): Promise<string>;
  submit(context: FormationContext, input: Record<string, unknown>, customerId: string, key: string): Promise<{ id: string; status: string }>;
  signature(context: FormationContext, companyId: string, documentType: 'SS4' | 'FORM8821'): Promise<{ url: string; expires_at: string }>;
}
