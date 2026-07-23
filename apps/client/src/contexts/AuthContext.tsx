import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, setActiveWorkspaceId, bootstrapActiveWorkspaceId } from '../api';
import { User } from '../types';

interface WorkspaceEntry {
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
  currentWorkspaceId: string | null;
  availableWorkspaces: WorkspaceEntry[];
  userStatus: 'active' | 'pending' | 'rejected' | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setup: (name: string, email: string, password: string) => Promise<void>;
  hasPermission: (perm: string) => boolean;
  refreshUser: () => Promise<void>;
  setCurrentWorkspace: (wsId: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

function resolveWorkspaceState(workspaces: WorkspaceEntry[], userStatus: string): {
  currentWorkspaceId: string | null;
  availableWorkspaces: WorkspaceEntry[];
  isAuthenticated: boolean;
} {
  if (userStatus !== 'active') {
    return { currentWorkspaceId: null, availableWorkspaces: [], isAuthenticated: false };
  }

  if (workspaces.length === 0) {
    // Active user but no workspace assigned yet — awaiting assignment
    return { currentWorkspaceId: null, availableWorkspaces: [], isAuthenticated: false };
  }

  if (workspaces.length === 1) {
    // Auto-select single workspace
    const wsId = workspaces[0].id;
    localStorage.setItem('currentWorkspaceId', wsId);
    return { currentWorkspaceId: wsId, availableWorkspaces: workspaces, isAuthenticated: true };
  }

  // Multiple workspaces — show picker
  // Restore previously selected workspace if still in the list. Prefer this
  // tab's own URL/sessionStorage over the cross-tab localStorage default —
  // otherwise a legacy route redirect (e.g. `/`) resolves to whatever
  // workspace another tab last touched (ticket dc5c0813).
  const saved = bootstrapActiveWorkspaceId();
  if (saved && workspaces.some(ws => ws.id === saved)) {
    return { currentWorkspaceId: saved, availableWorkspaces: workspaces, isAuthenticated: true };
  }

  return { currentWorkspaceId: null, availableWorkspaces: workspaces, isAuthenticated: false };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    token: localStorage.getItem('auth_token'),
    isAuthenticated: false,
    isLoading: true,
    needsSetup: false,
    serverUnavailable: false,
    currentWorkspaceId: localStorage.getItem('currentWorkspaceId'),
    availableWorkspaces: [],
    userStatus: null,
  });

  // 세션 복원
  const checkSession = useCallback(async () => {
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
      const workspaces: WorkspaceEntry[] = result.workspaces || [];
      const wsState = resolveWorkspaceState(workspaces, userStatus);

      setState({
        user: result,
        token: savedToken,
        isAuthenticated: wsState.isAuthenticated,
        isLoading: false,
        needsSetup: false,
        serverUnavailable: false,
        currentWorkspaceId: wsState.currentWorkspaceId,
        availableWorkspaces: wsState.availableWorkspaces,
        userStatus,
      });
    } catch {
      // 토큰 만료 또는 무효
      localStorage.removeItem('auth_token');
      try {
        const { needs_setup } = await api.getSetupStatus();
        setState({
          user: null, token: null, isAuthenticated: false, isLoading: false,
          needsSetup: needs_setup, serverUnavailable: false, currentWorkspaceId: null, availableWorkspaces: [], userStatus: null,
        });
      } catch {
        setState({
          user: null, token: null, isAuthenticated: false, isLoading: false,
          needsSetup: false, serverUnavailable: true, currentWorkspaceId: null, availableWorkspaces: [], userStatus: null,
        });
      }
    }
  }, []);

  useEffect(() => { checkSession(); }, [checkSession]);

  // Listen for auth-expired events from the API layer (e.g., 401 responses)
  useEffect(() => {
    const handler = () => {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('currentWorkspaceId');
      setActiveWorkspaceId(null);
      setState(prev => {
        if (!prev.isAuthenticated && !prev.user) return prev; // Already logged out
        return {
          ...prev, isAuthenticated: false, user: null, token: null,
          currentWorkspaceId: null, availableWorkspaces: [], userStatus: null,
        };
      });
    };
    window.addEventListener('auth-expired', handler);
    return () => window.removeEventListener('auth-expired', handler);
  }, []);

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
    const workspaces: WorkspaceEntry[] = result.workspaces || [];
    const wsState = resolveWorkspaceState(workspaces, userStatus);

    setState({
      user: result.user,
      token: result.token,
      isAuthenticated: wsState.isAuthenticated,
      isLoading: false,
      needsSetup: false,
      serverUnavailable: false,
      currentWorkspaceId: wsState.currentWorkspaceId,
      availableWorkspaces: wsState.availableWorkspaces,
      userStatus,
    });
  };

  const logout = async () => {
    try { await api.logout(); } catch { /* ignore */ }
    localStorage.removeItem('auth_token');
    localStorage.removeItem('currentWorkspaceId');
    setActiveWorkspaceId(null);
    setState({
      user: null, token: null, isAuthenticated: false, isLoading: false, needsSetup: false,
      serverUnavailable: false, currentWorkspaceId: null, availableWorkspaces: [], userStatus: null,
    });
  };

  const setup = async (name: string, email: string, password: string) => {
    const result = await api.setup({ name, email, password });
    localStorage.setItem('auth_token', result.token);
    setState({
      user: result.user,
      token: result.token,
      isAuthenticated: true,
      isLoading: false,
      needsSetup: false,
      serverUnavailable: false,
      currentWorkspaceId: null,
      availableWorkspaces: [],
      userStatus: 'active',
    });
  };

  const setCurrentWorkspace = (wsId: string) => {
    localStorage.setItem('currentWorkspaceId', wsId);
    setActiveWorkspaceId(wsId);
    setState(s => ({ ...s, currentWorkspaceId: wsId, isAuthenticated: true }));
  };

  const hasPermission = (perm: string): boolean => {
    if (!state.user) return false;
    const perms = state.user.resolved_permissions || [];
    return perms.includes(perm);
  };

  const refreshUser = async () => {
    try {
      const user = await api.getMe();
      setState(s => ({ ...s, user }));
    } catch { /* ignore */ }
  };

  return (
    <AuthContext.Provider value={{ ...state, login, logout, setup, hasPermission, refreshUser, setCurrentWorkspace }}>
      {children}
    </AuthContext.Provider>
  );
}
