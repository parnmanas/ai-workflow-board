import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { api, setActiveAccountId, bootstrapActiveAccountId } from '../api';
import {
  isAndroidApp,
  nativeRefreshToken,
  nativeSessionToken,
  notifyNativeLoggedIn,
  notifyNativeLoggedOut,
} from '../native/androidBridge';
import { User } from '../types';
import { loadCliCatalog } from '../cli/catalog';

interface AccountEntry {
  id: string;
  name: string;
  slug: string | null;
  relations: string[];
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  needsSetup: boolean;
  serverUnavailable: boolean;
  currentAccountId: string | null;
  availableAccounts: AccountEntry[];
  userStatus: 'active' | 'pending' | 'rejected' | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setup: (name: string, email: string, password: string) => Promise<void>;
  hasPermission: (perm: string) => boolean;
  refreshUser: () => Promise<void>;
  setCurrentAccount: (accountId: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function resolveAccountState(accounts: AccountEntry[], userStatus: string): {
  currentAccountId: string | null;
  availableAccounts: AccountEntry[];
  isAuthenticated: boolean;
} {
  if (userStatus !== 'active' || accounts.length === 0) {
    setActiveAccountId(null);
    return { currentAccountId: null, availableAccounts: accounts, isAuthenticated: false };
  }

  // Ownership defaults never interrupt sign-in with a work-container picker.
  const saved = bootstrapActiveAccountId();
  const accountId = accounts.find((account) => account.id === saved)?.id || accounts[0].id;
  try { localStorage.setItem('currentAccountId', accountId); } catch {}
  setActiveAccountId(accountId);
  return { currentAccountId: accountId, availableAccounts: accounts, isAuthenticated: true };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    token: localStorage.getItem('auth_token'),
    isAuthenticated: false,
    isLoading: true,
    needsSetup: false,
    serverUnavailable: false,
    currentAccountId: localStorage.getItem('currentAccountId'),
    availableAccounts: [],
    userStatus: null,
  });

  // 세션 복원
  const checkSession = useCallback(async () => {
    // Android 앱은 단말 자격으로 세션을 이어 붙인다 — 서버가 다시 떠서 저장된 토큰이 죽었어도
    // 앱이 새 세션을 준다(다시 로그인하지 않는다).
    if (isAndroidApp()) {
      const nativeToken = await nativeSessionToken();
      if (nativeToken) localStorage.setItem('auth_token', nativeToken);
    }
    const savedToken = localStorage.getItem('auth_token');

    if (!savedToken) {
      // 토큰 없으면 setup 필요 여부 확인
      try {
        const { needs_setup } = await api.getSetupStatus();
        setState(s => ({ ...s, isLoading: false, needsSetup: needs_setup, serverUnavailable: false }));
      } catch {
        setState(s => ({ ...s, isLoading: false, needsSetup: false, serverUnavailable: true }));
      }
      return;
    }

    try {
      const result = await api.getMe();
      const userStatus = (result.status || 'active') as 'active' | 'pending' | 'rejected';
      const accounts: AccountEntry[] = result.accounts || [];
      const wsState = resolveAccountState(accounts, userStatus);

      setState({
        user: result,
        token: savedToken,
        isAuthenticated: wsState.isAuthenticated,
        isLoading: false,
        needsSetup: false,
        serverUnavailable: false,
        currentAccountId: wsState.currentAccountId,
        availableAccounts: wsState.availableAccounts,
        userStatus,
      });
    } catch {
      // 토큰 만료 또는 무효
      localStorage.removeItem('auth_token');
      try {
        const { needs_setup } = await api.getSetupStatus();
        setState({
          user: null, token: null, isAuthenticated: false, isLoading: false,
          needsSetup: needs_setup, serverUnavailable: false, currentAccountId: null, availableAccounts: [], userStatus: null,
        });
      } catch {
        setState({
          user: null, token: null, isAuthenticated: false, isLoading: false,
          needsSetup: false, serverUnavailable: true, currentAccountId: null, availableAccounts: [], userStatus: null,
        });
      }
    }
  }, []);

  useEffect(() => { checkSession(); }, [checkSession]);

  // Listen for auth-expired events from the API layer (e.g., 401 responses)
  const tokenRef = useRef<string | null>(state.token);
  tokenRef.current = state.token;
  const nativeRefreshAt = useRef(0);
  useEffect(() => {
    const handler = () => {
      // Android 앱: 세션이 끊긴 것(배포 재시작 · 24시간)이면 앱이 새 세션을 준다. 한 번만 시도한다 —
      // 앱도 못 주면(단말 자격 회수) 진짜 로그아웃이다.
      if (isAndroidApp() && Date.now() - nativeRefreshAt.current > 30_000) {
        nativeRefreshAt.current = Date.now();
        const rejected = tokenRef.current || '';
        void nativeRefreshToken(rejected).then((fresh) => {
          if (fresh) {
            localStorage.setItem('auth_token', fresh);
            void checkSession();
          } else {
            expire();
          }
        });
        return;
      }
      expire();
    };
    const expire = () => {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('currentAccountId');
      setActiveAccountId(null);
      setState(prev => {
        if (!prev.isAuthenticated && !prev.user) return prev; // Already logged out
        return {
          ...prev, isAuthenticated: false, user: null, token: null,
          currentAccountId: null, availableAccounts: [], userStatus: null,
        };
      });
    };
    window.addEventListener('auth-expired', handler);
    return () => window.removeEventListener('auth-expired', handler);
  }, [checkSession]);

  // Android 앱에 로그인을 알린다 — 앱이 단말 자격을 받아 두고(처음이면) 상시 음성을 켠다.
  useEffect(() => {
    if (state.isAuthenticated && state.token) notifyNativeLoggedIn(state.token);
  }, [state.isAuthenticated, state.token]);

  // Load the LLM CLI catalog once a session exists (the endpoint needs a
  // logged-in user; `isAuthenticated` is false for pending users / users
  // without a account, so key on the user instead). Failure keeps the
  // static mirror — nothing here blocks.
  useEffect(() => {
    if (!state.user) return;
    void loadCliCatalog();
  }, [state.user?.id]);

  // Periodic session health check (every 60s while authenticated)
  useEffect(() => {
    if (!state.isAuthenticated) return;
    const interval = setInterval(async () => {
      try {
        await api.getMe();
      } catch {
        // 401 will trigger auth-expired via api.ts
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [state.isAuthenticated]);

  const login = async (email: string, password: string) => {
    const result = await api.login(email, password);
    localStorage.setItem('auth_token', result.token);

    const userStatus = (result.user?.status || 'active') as 'active' | 'pending' | 'rejected';
    const accounts: AccountEntry[] = result.accounts || [];
    const wsState = resolveAccountState(accounts, userStatus);

    setState({
      user: result.user,
      token: result.token,
      isAuthenticated: wsState.isAuthenticated,
      isLoading: false,
      needsSetup: false,
      serverUnavailable: false,
      currentAccountId: wsState.currentAccountId,
      availableAccounts: wsState.availableAccounts,
      userStatus,
    });
  };

  const logout = async () => {
    await notifyNativeLoggedOut();
    try { await api.logout(); } catch { /* ignore */ }
    localStorage.removeItem('auth_token');
    localStorage.removeItem('currentAccountId');
    setActiveAccountId(null);
    setState({
      user: null, token: null, isAuthenticated: false, isLoading: false, needsSetup: false,
      serverUnavailable: false, currentAccountId: null, availableAccounts: [], userStatus: null,
    });
  };

  const setup = async (name: string, email: string, password: string) => {
    const result = await api.setup({ name, email, password });
    localStorage.setItem('auth_token', result.token);
    const profile = await api.getMe();
    const ownership = resolveAccountState(profile.accounts || [], 'active');
    setState({
      user: profile,
      token: result.token,
      isAuthenticated: ownership.isAuthenticated,
      isLoading: false,
      needsSetup: false,
      serverUnavailable: false,
      currentAccountId: ownership.currentAccountId,
      availableAccounts: ownership.availableAccounts,
      userStatus: 'active',
    });
  };

  const setCurrentAccount = (accountId: string) => {
    localStorage.setItem('currentAccountId', accountId);
    setActiveAccountId(accountId);
    setState(s => ({ ...s, currentAccountId: accountId, isAuthenticated: true }));
  };

  const hasPermission = (perm: string): boolean => {
    if (!state.user) return false;
    const perms = state.user.resolved_permissions || [];
    return perms.includes(perm);
  };

  const refreshUser = async () => {
    try {
      const user = await api.getMe();
      const ownership = resolveAccountState(user.accounts || [], user.status || 'active');
      setState(s => ({ ...s, user, ...ownership }));
    } catch { /* ignore */ }
  };

  return (
    <AuthContext.Provider value={{ ...state, login, logout, setup, hasPermission, refreshUser, setCurrentAccount }}>
      {children}
    </AuthContext.Provider>
  );
}
