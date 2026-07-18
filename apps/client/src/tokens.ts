export const tokens = {
  colors: {
    // Surface
    surface: '#0f172a',
    surfaceCard: '#1e293b',
    surfaceHover: '#283548',
    surfaceSubtle: '#1a2535',
    // Border
    border: '#334155',
    borderStrong: '#475569',
    // Text
    textPrimary: '#f1f5f9',
    textStrong: '#e2e8f0',
    textSecondary: '#94a3b8',
    textMuted: '#64748b',
    textDisabled: '#cbd5e1',
    // 어두운 스크림/오버레이 위 텍스트(항상 흰색) — rgba scrim 위 라벨용
    textInverse: '#ffffff',
    // Accent
    accent: '#6366f1',
    accentViolet: '#8b5cf6',
    accentLight: '#a78bfa',
    accentSubtle: '#a5b4fc',
    accentMid: '#818cf8',
    accentPale: '#c7d2fe',
    // Status
    success: '#10b981',
    successLight: '#34d399',
    successPale: '#6ee7b7',
    successBg: '#065f46',
    successDark: '#059669',
    danger: '#ef4444',
    dangerMid: '#f87171',
    dangerLight: '#fca5a5',
    dangerBg: '#7f1d1d',
    warning: '#f59e0b',
    warningLight: '#fbbf24',
    warningBg: '#78350f',
    info: '#60a5fa',
    infoLight: '#38bdf8',
    // Badge surfaces (system/agent/user comment badges)
    badgeSystemBg: '#1c1917',
    badgeSystemBorder: '#292524',
    badgeSystemSurface: '#0c0a09',
    badgeSystemText: '#a8a29e',
    badgeAgentBg: '#1e1b4b',
    badgeUserBg: '#0c4a6e',
  },
  // 반투명 오버레이/스크림/틴트 계층 — 여기저기 흩어져 있던 raw rgba() 를
  // 단일 원천으로 수렴한다(F2-2). accent 틴트는 accent(#6366f1 = rgb(99,102,241))의
  // 알파 변주다.
  overlays: {
    backdrop: 'rgba(0,0,0,0.6)',        // 모달/피커 배경 딤
    backdropSoft: 'rgba(0,0,0,0.4)',    // 드로어 사이드바 배경 딤
    scrimStrong: 'rgba(0,0,0,0.85)',    // 전체화면 이미지 라이트박스
    imageBarSubtle: 'rgba(0,0,0,0.35)', // 이미지 위 액션/캡션 바(약)
    imageBar: 'rgba(0,0,0,0.45)',       // 이미지 위 액션/캡션 바
    imageBarStrong: 'rgba(0,0,0,0.7)',  // 이미지 위 액션/캡션 바(강)
    accentFaint: 'rgba(99,102,241,0.08)',   // 선택/호버 accent 틴트(약)
    accentSoft: 'rgba(99,102,241,0.12)',    // 티켓 카드 기본 배경
    accentTint: 'rgba(99,102,241,0.15)',    // agent 멘션 배경
    accentStrong: 'rgba(99,102,241,0.20)',  // 티켓 카드 호버 / 하이라이트 플래시
    accentStronger: 'rgba(99,102,241,0.22)',// 티켓 카드 이미지 배지
    rowHover: 'rgba(255,255,255,0.04)',     // 리스트 행 호버
  },
  gradients: {
    surfacePage: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
    surfaceCard: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
    accent: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
    warning: 'linear-gradient(135deg, #f59e0b, #d97706)',
    accentShimmer: 'linear-gradient(90deg, #6366f1, #8b5cf6, #6366f1)',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    '2xl': 48,
    '3xl': 64,
  },
  typography: {
    fontSizeXs: 11,
    fontSizeMd: 13,
    fontSizeLg: 14,
    fontSizeXl: 16,
    fontWeightNormal: 400,
    fontWeightSemibold: 600,
    lineHeightBody: 1.5,
    lineHeightHeading: 1.2,
    lineHeightCaption: 1.4,
  },
  radii: {
    xs: 2,
    sm: 4,
    md: 6,
    lg: 8,
    xl: 12,
    full: '50%',
  },
  shadows: {
    card: '0 8px 32px rgba(0,0,0,0.4)',
    dropdown: '0 4px 20px rgba(0,0,0,0.4)',
    panel: '-8px 0 30px rgba(0,0,0,0.4)',
    modal: '0 16px 48px rgba(0,0,0,0.5)',
    overlay: '0 20px 60px rgba(0,0,0,0.5)',
    overlayDark: '0 20px 60px rgba(0,0,0,0.6)',
  },
} as const;
