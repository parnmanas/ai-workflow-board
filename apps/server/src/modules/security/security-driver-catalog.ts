import type { SecurityCategory, SecurityTargetKind } from '../../entities/SecurityProfile';

export interface SecurityDriverDef {
  driver: string;
  category: SecurityCategory;
  label: string;
  target_kinds: SecurityTargetKind[];
  description: string;
  /** refresh 시 agent 가 WebSearch 해야 할 지식 소스 힌트 */
  intel_sources: string[];
}

export const SECURITY_DRIVER_CATALOG: SecurityDriverDef[] = [
  {
    driver: 'code-review',
    category: 'internal',
    label: '소스코드 리뷰',
    target_kinds: ['code'],
    description: 'OWASP Top 10 / authz / injection / XSS 기준 소스코드 정적 리뷰',
    intel_sources: ['OWASP Top 10 최신판', 'CWE', '스택 CVE/GHSA (package.json)', 'Node/Express advisory'],
  },
  {
    driver: 'secrets',
    category: 'internal',
    label: '시크릿·키 검사',
    target_kinds: ['code'],
    description: '하드코딩된 키·토큰·연결문자열 + 로그/응답 마스킹 검사',
    intel_sources: ['CWE-798/532', 'GitHub secret scanning 문서'],
  },
  {
    driver: 'dependency',
    category: 'internal',
    label: '의존성 검사',
    target_kinds: ['code'],
    description: 'package.json/lockfile 취약 버전 + 미관리 패키지 검사 (npm audit 관점)',
    intel_sources: ['GHSA/npm advisories', 'OSV.dev', 'Socket.dev'],
  },
  {
    driver: 'config-iac',
    category: 'internal',
    label: '설정·환경 검사',
    target_kinds: ['code', 'host'],
    description: 'CORS/CSP/헤더, dev bypass, DB synchronize, Docker/K8s 매니페스트, env·권한 검사',
    intel_sources: ['OWASP Secure Configuration', 'Docker/K8s CIS Benchmark'],
  },
  {
    driver: 'host-check',
    category: 'internal',
    label: '호스트 검사 (agent-manager)',
    target_kinds: ['host'],
    description: 'agent-manager 호스트의 OS·런타임·CLI 설정·열린 포트·파일권한·패치 상태 점검',
    intel_sources: ['CIS Benchmark (OS)', 'Node/CLI 보안 권고'],
  },
  {
    driver: 'nuclei',
    category: 'external',
    label: 'Nuclei 템플릿 스캔',
    target_kinds: ['url'],
    description: '외부 공개 엔드포인트에 Nuclei 템플릿 기반 취약점 스캔 (읽기전용)',
    intel_sources: ['Nuclei templates 릴리스', 'CVE/GHSA 최신'],
  },
  {
    driver: 'zap-baseline',
    category: 'external',
    label: 'OWASP ZAP baseline',
    target_kinds: ['url'],
    description: 'ZAP baseline 스캔 — 수동 크롤 + 패시브 룰, 공격 페이로드 금지',
    intel_sources: ['OWASP ZAP 릴리스노트', 'OWASP Testing Guide (WSTG)'],
  },
  {
    driver: 'nmap',
    category: 'external',
    label: '포트·서비스 스캔',
    target_kinds: ['host', 'url'],
    description: 'nmap -sV 수준 포트/서비스 노출면 파악 (intrusive NSE 스크립트 제외)',
    intel_sources: ['Nmap changelog', '노출 서비스 CVE'],
  },
  {
    driver: 'tls-check',
    category: 'external',
    label: 'TLS·헤더 검사',
    target_kinds: ['url'],
    description: 'TLS 버전/인증서 + security headers (HSTS/CSP/XFO) 외부 관점 검사',
    intel_sources: ['Mozilla SSL Config Generator', 'securityheaders.com 기준'],
  },
];

export function normalizeCategory(v: any): SecurityCategory {
  return v === 'external' ? 'external' : 'internal';
}

export function normalizeTargetKind(v: any): SecurityTargetKind {
  return v === 'host' || v === 'url' ? v : 'code';
}

export function driverDefFor(driver: string | null | undefined): SecurityDriverDef | null {
  if (!driver) return null;
  return SECURITY_DRIVER_CATALOG.find((d) => d.driver === driver) ?? null;
}

/** 카테고리↔드라이버 불일치 시 경고 문구 (거부는 하지 않는다 — custom 드라이버 허용). */
export function categoryDriverMismatch(category: SecurityCategory, driver: string): string | null {
  const def = driverDefFor(driver);
  if (!def) return null;
  if (def.category !== category) {
    return `category '${category}'와 driver '${driver}'(기본 ${def.category})가 다릅니다 — 의도적이면 유지, 아니면 카탈로그를 확인하세요.`;
  }
  return null;
}
