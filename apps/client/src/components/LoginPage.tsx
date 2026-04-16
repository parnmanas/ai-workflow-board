import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api';
import { tokens } from '../tokens';

type Mode = 'login' | 'setup' | 'register';

export default function LoginPage() {
  const { login, setup, needsSetup, userStatus, availableWorkspaces, currentWorkspaceId, setCurrentWorkspace } = useAuth();
  const [mode, setMode] = useState<Mode>(needsSetup ? 'setup' : 'login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [publicWorkspaces, setPublicWorkspaces] = useState<{ id: string; name: string; slug: string }[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

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
                onClick={() => setCurrentWorkspace(ws.id)}
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
