import { getDomain } from 'tldts';
import { publicBaseUrl } from './public-url';

export function previewDomain(): string {
  const value = process.env.AWB_PREVIEW_DOMAIN?.trim().toLowerCase() ?? '';
  const dnsName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
  return value.length <= 200 && dnsName.test(value) && getDomain(value, { allowPrivateDomains: true }) ? value : '';
}

export function isolatedPreviewDomain(awbOrigin: string): string {
  const domain = previewDomain();
  const site = (host: string) => getDomain(host, { allowPrivateDomains: true }) || host;
  if (!domain || !awbOrigin) return '';
  for (const base of [awbOrigin, publicBaseUrl()].filter(Boolean)) {
    if (!URL.canParse(base) || site(new URL(base).hostname) === site(domain)) return '';
  }
  return domain;
}
