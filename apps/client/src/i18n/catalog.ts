import type { BusinessConnector, SelfServiceAssessment, TrademarkConnectorDefinition } from '../business.types';
import type { MailConnections } from '../business-mail.types';
import { t } from './core';

// Only immutable product descriptions belong here. Connections, records, messages,
// credentials and other user/provider content must keep their original values.
// Getters let already loaded catalogs follow a language switch without refetching.
function copyLabels<T extends object>(source: T, fields: readonly (keyof T)[]): T {
  const result = { ...source };
  for (const key of fields) {
    const value = source[key];
    Object.defineProperty(result, key, {
      enumerable: true,
      configurable: true,
      get: () => typeof value === 'string' ? t(value)
        : Array.isArray(value) ? value.map(label => typeof label === 'string' ? t(label) : label) : value,
    });
  }
  return result;
}

export function localizeBusinessConnector(source: BusinessConnector): BusinessConnector {
  const result = copyLabels(source, ['name', 'summary', 'capabilities', 'setup_note']);
  result.fields = source.fields.map(field => copyLabels(field, ['label', 'placeholder']));
  if (source.offering) {
    result.offering = copyLabels(source.offering, ['best_for', 'features', 'api_note', 'external_steps']);
    result.offering.pricing = copyLabels(source.offering.pricing, ['extra']);
    result.offering.pricing.plans = source.offering.pricing.plans.map(plan => copyLabels(plan, ['name', 'price', 'detail']));
  }
  return result;
}

export function localizeTrademarkConnector(source: TrademarkConnectorDefinition): TrademarkConnectorDefinition {
  const result = copyLabels(source, ['name', 'capabilities', 'setup']);
  result.fields = source.fields.map(field => copyLabels(field, ['label', 'placeholder']));
  return result;
}

export function localizeMailConnector(source: MailConnections['connectors'][number]): MailConnections['connectors'][number] {
  return copyLabels(source, ['note']);
}

export function localizeSelfServiceAssessment(source: SelfServiceAssessment): SelfServiceAssessment {
  const result = copyLabels(source, ['scope', 'notices']);
  result.questions = source.questions.map(question => copyLabels(question, ['label', 'detail']));
  result.residency = source.residency.map(item => copyLabels(item, ['subject', 'status', 'condition']));
  result.steps = source.steps.map(step => copyLabels(step, ['title', 'where', 'detail']));
  result.sources = source.sources.map(reference => copyLabels(reference, ['label']));
  Object.defineProperty(result, 'blockers', {
    enumerable: true,
    get: () => source.blockers.map(blocker => {
      const question = source.questions.find(item => blocker === `${item.label} — ${item.detail}`);
      return question ? `${t(question.label)} — ${t(question.detail)}` : t(blocker);
    }),
  });
  return result;
}
