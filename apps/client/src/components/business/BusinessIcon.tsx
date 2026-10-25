import React from 'react';

const paths: Record<string, React.ReactNode> = {
  filter: <><path d="M3 6h18M6 12h12M9 18h6" /></>,
  trademark: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="M8 9h8m-4 0v7" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m3 7 9 6 9-6" /></>,
  formation: <><path d="M4 21V7l8-4 8 4v14M2 21h20M9 21v-5h6v5" /><path d="M8 9h1m6 0h1M8 12h1m6 0h1" /></>,
  banking: <><path d="m3 9 9-6 9 6H3ZM3 21h18M5 18v-6m7 6v-6m7 6v-6" /></>,
  payments: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 10h18M7 15h3" /></>,
  accounting: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 7h6M9 11h6M9 15h3" /></>,
  support: <><path d="M4 14v-3a8 8 0 0 1 16 0v3M20 16v2a3 3 0 0 1-3 3h-4" /><rect x="2" y="11" width="4" height="6" rx="2" /><rect x="18" y="11" width="4" height="6" rx="2" /></>,
  growth: <><path d="M3 17 9 11l4 4 8-10M15 5h6v6M4 21h16" /></>,
  overview: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
  connector: <><path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5" /></>,
  workflow: <><rect x="3" y="3" width="6" height="6" rx="2" /><rect x="15" y="15" width="6" height="6" rx="2" /><path d="M9 6h7a2 2 0 0 1 2 2v7M6 9v9h9" /></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  external: <><path d="M14 3h7v7m0-7L10 14M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
};
export function BusinessIcon({ name, size = 20 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.workflow}</svg>;
}
