import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api';
import { tokens } from '../tokens';

type Mode = 'login' | 'setup' | 'register';

export default function LoginPage() {
  const { login, setup, needsSetup, userStatus, availableWorkspaces, currentWorkspaceId, setCurrentWorkspace } = useAuth();
  const navigate = useNavigate();
  // Picking a workspace must drive the URL too. Without an explicit navigate,
  // a stale `/ws/<old>/...` URL (e.g. left over from an expired session)
  // wins the next AppLayout sync and silently swaps in the wrong workspace.
  const pickWorkspace = (wsId: string) => {
    setCurrentWorkspace(wsId);
    navigate(`/ws/${wsId}/boards`, { replace: true });
  };
  const [mode, setMode] = useState<Mode>(needsSetup ? 'setup' : 'login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [publicWorkspaces, setPublicWorkspaces] = useState<{ id: string; name: string; slug: string }[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const tokenConsumedRef = useRef(false);

  // Handle OAuth callback: ?token= stores session, ?oauth_error= shows error
  useEffect(() => {
    if (tokenConsumedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const oauthError = params.get('oauth_error');
    if (token) {
      tokenConsumedRef.current = true;
      localStorage.setItem('auth_token', token);
      // Strip query string then reload so AuthContext picks up the token
      window.location.replace(window.location.pathname);
    } else if (oauthError) {
      tokenConsumedRef.current = true;
      setError(decodeURIComponent(oauthError).replace(/_/g, ' '));
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Fetch Google OAuth config
  useEffect(() => {
    fetch('/api/auth/oauth/config')
      .then(r => r.json())
      .then((data: any) => setGoogleEnabled(!!data?.google?.enabled))
      .catch(() => setGoogleEnabled(false));
  }, []);

  // Load public workspaces when register tab is active
  useEffect(() => {
    if (mode === 'register') {
      api.getPublicWorkspaces().then(setPublicWorkspaces).catch(() => setPublicWorkspaces([]));
    }
  }, [mode]);

  // Show pending approval screen
  if (userStatus === 'pending') {
    return (
      <div style={{
        minHeight: '100vh',
        background: tokens.gradients.surfacePage,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{
          width: '100%', maxWidth: 400, background: tokens.colors.surfaceCard, borderRadius: 16,
          border: `1px solid ${tokens.colors.border}`, boxShadow: tokens.shadows.overlay, padding: 32,
          textAlign: 'center',
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: tokens.gradients.warning,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '28px', fontWeight: 700, color: 'white', marginBottom: 16,
          }}>?</div>
          <h1 style={{ fontSize: '20px', fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>
            Awaiting Approval
          </h1>
          <p style={{ fontSize: '14px', color: tokens.colors.textSecondary, lineHeight: 1.6, marginBottom: 24 }}>
            Your account is awaiting admin approval. Please refresh to check status.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 24px', background: tokens.colors.accent, color: 'white',
              border: 'none', borderRadius: tokens.radii.lg, fontSize: '14px', fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }

  // Show awaiting workspace assignment screen (active user, no workspaces)
  if (userStatus === 'active' && availableWorkspaces.length === 0) {
    return (
      <div style={{
        minHeight: '100vh',
        background: tokens.gradients.surfacePage,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{
          width: '100%', maxWidth: 400, background: tokens.colors.surfaceCard, borderRadius: 16,
          border: `1px solid ${tokens.colors.border}`, boxShadow: tokens.shadows.overlay, padding: 32,
          textAlign: 'center',
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: tokens.gradients.accent,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '28px', fontWeight: 700, color: 'white', marginBottom: 16,
          }}>W</div>
          <h1 style={{ fontSize: '20px', fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>
            Account Approved
          </h1>
          <p style={{ fontSize: '14px', color: tokens.colors.textSecondary, lineHeight: 1.6, marginBottom: 24 }}>
            Your account is approved. Waiting for admin to assign a workspace. Please refresh to check status.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 24px', background: tokens.colors.accent, color: 'white',
              border: 'none', borderRadius: tokens.radii.lg, fontSize: '14px', fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }

  // Show workspace picker for multi-workspace users
  if (userStatus === 'active' && availableWorkspaces.length > 1 && !currentWorkspaceId) {
    return (
      <div style={{
        minHeight: '100vh',
        background: tokens.gradients.surfacePage,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{
          width: '100%', maxWidth: 440, background: tokens.colors.surfaceCard, borderRadius: 16,
          border: `1px solid ${tokens.colors.border}`, boxShadow: tokens.shadows.overlay, padding: 32,
        }}>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{
              width: 56, height: 56, borderRadius: 14,
              background: tokens.gradients.accent,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '28px', fontWeight: 700, color: 'white', marginBottom: 16,
            }}>W</div>
            <h1 style={{ fontSize: '20px', fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 4 }}>
              Select Workspace
            </h1>
            <p style={{ fontSize: '13px', color: tokens.colors.textMuted }}>
              Choose a workspace to continue
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {availableWorkspaces.map(ws => (
              <button
                key={ws.id}
                onClick={() => pickWorkspace(ws.id)}
                style={{
                  padding: '14px 18px', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
                  borderRadius: 10, color: tokens.colors.textStrong, cursor: 'pointer', textAlign: 'left',
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = tokens.colors.accent)}
                onMouseLeave={e => (e.currentTarget.style.borderColor = tokens.colors.border)}
              >
                <div style={{ fontSize: '14px', fontWeight: 600 }}>{ws.name}</div>
                {ws.slug && (
                  <div style={{ fontSize: '12px', color: tokens.colors.textMuted, marginTop: 2 }}>/{ws.slug}</div>
                )}
                <div style={{ fontSize: '11px', color: tokens.colors.borderStrong, marginTop: 4 }}>
                  {ws.relations.join(', ')}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      if (mode === 'setup') {
        if (!form.name.trim() || !form.email.trim() || !form.password.trim()) {
          setError('All fields are required');
          setLoading(false);
          return;
        }
        await setup(form.name, form.email, form.password);
      } else if (mode === 'register') {
        if (!form.name.trim() || !form.email.trim() || !form.password.trim()) {
          setError('All fields are required');
          setLoading(false);
          return;
        }
        if (form.password.length < 4) {
          setError('Password must be at least 4 characters');
          setLoading(false);
          return;
        }
        const result = await api.register(form.name, form.email, form.password, selectedWorkspaceId || undefined);
        setSuccess(result.message);
        setForm({ name: '', email: '', password: '' });
        setSelectedWorkspaceId('');
      } else {
        if (!form.email.trim() || !form.password.trim()) {
          setError('Email and password are required');
          setLoading(false);
          return;
        }
        await login(form.email, form.password);
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (newMode: Mode) => {
    setMode(newMode);
    setError('');
    setSuccess('');
    setForm({ name: '', email: '', password: '' });
    setSelectedWorkspaceId('');
  };

  const showNameField = mode === 'setup' || mode === 'register';

  return (
    <div style={{
      minHeight: '100vh',
      background: tokens.gradients.surfacePage,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
    }}>
      <div style={{
        width: '100%',
        maxWidth: 400,
        background: tokens.colors.surfaceCard,
        borderRadius: 16,
        border: `1px solid ${tokens.colors.border}`,
        boxShadow: tokens.shadows.overlay,
        padding: 32,
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: tokens.gradients.accent,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '28px', fontWeight: 700, color: 'white',
            marginBottom: 16,
          }}>W</div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 4 }}>
            {mode === 'setup' ? 'Initial Setup' : mode === 'register' ? 'Create Account' : 'Welcome Back'}
          </h1>
          <p style={{ fontSize: '13px', color: tokens.colors.textMuted }}>
            {mode === 'setup'
              ? 'Create your admin account to get started'
              : mode === 'register'
                ? 'Register and wait for admin approval'
                : 'Sign in to continue'}
          </p>
        </div>

        {/* Setup Banner */}
        {mode === 'setup' && (
          <div style={{
            background: '#6366f110',
            border: '1px solid #6366f130',
            borderRadius: tokens.radii.lg,
            padding: '10px 14px',
            marginBottom: 20,
            fontSize: '12px',
            color: tokens.colors.accentSubtle,
            lineHeight: 1.5,
          }}>
            First time setup. Create an admin account with full access to manage the system.
          </div>
        )}

        {/* Success */}
        {success && (
          <div style={{
            background: '#065f4620',
            border: '1px solid #065f4650',
            borderRadius: tokens.radii.lg,
            padding: '10px 14px',
            marginBottom: 16,
            fontSize: '12px',
            color: tokens.colors.successPale,
            lineHeight: 1.5,
          }}>
            {success}
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            background: '#7f1d1d20',
            border: '1px solid #7f1d1d50',
            borderRadius: tokens.radii.lg,
            padding: '10px 14px',
            marginBottom: 16,
            fontSize: '12px',
            color: tokens.colors.dangerLight,
          }}>{error}</div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {showNameField && (
            <div>
              <label style={{
                fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600,
                textTransform: 'uppercase', display: 'block', marginBottom: 6,
              }}>Name</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder={mode === 'setup' ? 'Admin Name' : 'Your Name'}
                autoComplete="name"
                style={{
                  width: '100%', padding: '10px 14px', background: tokens.colors.surface,
                  border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg, color: tokens.colors.textStrong,
                  fontSize: '14px', outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
          )}

          <div>
            <label style={{
              fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600,
              textTransform: 'uppercase', display: 'block', marginBottom: 6,
            }}>Email</label>
            <input
              type="email"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              placeholder="email@example.com"
              autoComplete="email"
              autoFocus
              style={{
                width: '100%', padding: '10px 14px', background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg, color: tokens.colors.textStrong,
                fontSize: '14px', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>

          <div>
            <label style={{
              fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600,
              textTransform: 'uppercase', display: 'block', marginBottom: 6,
            }}>Password</label>
            <input
              type="password"
              value={form.password}
              onChange={e => setForm({ ...form, password: e.target.value })}
              placeholder={mode === 'login' ? 'Enter password' : 'Min 4 characters'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              style={{
                width: '100%', padding: '10px 14px', background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg, color: tokens.colors.textStrong,
                fontSize: '14px', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Workspace dropdown — register only */}
          {mode === 'register' && (
            <div>
              <label style={{
                fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600,
                textTransform: 'uppercase', display: 'block', marginBottom: 6,
              }}>Workspace (optional)</label>
              <select
                value={selectedWorkspaceId}
                onChange={e => setSelectedWorkspaceId(e.target.value)}
                style={{
                  width: '100%', padding: '10px 14px', background: tokens.colors.surface,
                  border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg, color: tokens.colors.textStrong,
                  fontSize: '14px', outline: 'none', boxSizing: 'border-box',
                }}
              >
                <option value="">-- Select a workspace --</option>
                {publicWorkspaces.map(ws => (
                  <option key={ws.id} value={ws.id}>{ws.name}</option>
                ))}
              </select>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '12px',
              background: loading ? tokens.colors.accent : mode === 'register' ? tokens.colors.successDark : tokens.colors.accent,
              color: 'white', border: 'none', borderRadius: tokens.radii.lg, fontSize: '14px',
              fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1, transition: 'all 0.2s',
              marginTop: 4,
            }}
          >
            {loading
              ? 'Please wait...'
              : mode === 'setup'
                ? 'Create Admin Account'
                : mode === 'register'
                  ? 'Register'
                  : 'Sign In'}
          </button>
        </form>

        {/* Google OAuth — login mode only */}
        {mode === 'login' && googleEnabled && (
          <div style={{ marginTop: 12 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
            }}>
              <div style={{ flex: 1, height: 1, background: tokens.colors.border }} />
              <span style={{ fontSize: 11, color: tokens.colors.textMuted, whiteSpace: 'nowrap' }}>or</span>
              <div style={{ flex: 1, height: 1, background: tokens.colors.border }} />
            </div>
            <a
              href="/api/auth/oauth/google/start"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                width: '100%', padding: '11px 14px',
                background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.lg,
                color: tokens.colors.textStrong,
                fontSize: 14, fontWeight: 600,
                textDecoration: 'none',
                boxSizing: 'border-box',
                transition: 'border-color 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = tokens.colors.borderStrong)}
              onMouseLeave={e => (e.currentTarget.style.borderColor = tokens.colors.border)}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
                <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
                <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
                <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
              </svg>
              Continue with Google
            </a>
          </div>
        )}

        {/* Toggle between login and register */}
        {mode !== 'setup' && (
          <div style={{ textAlign: 'center', marginTop: 20 }}>
            <span style={{ fontSize: '13px', color: tokens.colors.textMuted }}>
              {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            </span>
            <button
              onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
              style={{
                background: 'none', border: 'none', color: tokens.colors.accentMid,
                fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                textDecoration: 'underline', padding: 0,
              }}
            >
              {mode === 'login' ? 'Register' : 'Sign In'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
