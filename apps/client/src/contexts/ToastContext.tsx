import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { tokens } from '../tokens';
import {
  getNotificationPrefs,
  setNotificationPref,
  subscribeNotificationPrefs,
} from './notificationPrefs';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
  /** Optional click target — set for notification toasts so the toast is a
   *  navigable link to whatever it is announcing, not a dead banner. */
  onClick?: () => void;
}

export interface ToastOptions {
  /** Click handler; makes the toast interactive (pointer cursor + role=button). */
  onClick?: () => void;
  /** Auto-dismiss delay in ms. Default 4000. */
  durationMs?: number;
}

interface ToastContextType {
  showToast: (
    message: string,
    type?: 'success' | 'error' | 'info',
    options?: ToastOptions,
  ) => void;
  muted: boolean;
  toggleMute: () => void;
  playNotifySound: () => void;
}

const ToastContext = createContext<ToastContextType>({
  showToast: () => {},
  muted: false,
  toggleMute: () => {},
  playNotifySound: () => {},
});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(0);

  // Mute state is a projection of the shared notification prefs record — the
  // same value the "Audio cue" toggle in NotificationSettingsPanel writes.
  // Keeping a private copy of `chat_notify_muted` here is what let the two
  // controls drift apart (see notificationPrefs.ts header).
  const [muted, setMuted] = useState<boolean>(() => !getNotificationPrefs().audio);
  useEffect(() => subscribeNotificationPrefs((p) => setMuted(!p.audio)), []);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockedRef = useRef(false);

  // Initialize audio element once
  useEffect(() => {
    audioRef.current = new Audio('/sounds/notify.mp3');
    audioRef.current.volume = 0.6;
  }, []);

  // Autoplay unlock via first user gesture (required by iOS/Chrome autoplay policy)
  useEffect(() => {
    const unlock = () => {
      if (audioUnlockedRef.current) return;
      audioUnlockedRef.current = true;
      if (audioRef.current) {
        audioRef.current.play().then(() => audioRef.current?.pause()).catch(() => {});
        audioRef.current.currentTime = 0;
      }
    };
    document.addEventListener('click', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, []);

  const toggleMute = useCallback(() => {
    // Write through the shared record so the settings panel's Audio toggle
    // reflects the change immediately (and vice versa).
    setNotificationPref('audio', !getNotificationPrefs().audio);
  }, []);

  const playNotifySound = useCallback(() => {
    if (!muted && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
    }
  }, [muted]);

  const showToast = useCallback((
    message: string,
    type: 'success' | 'error' | 'info' = 'info',
    options?: ToastOptions,
  ) => {
    const id = ++nextIdRef.current;
    setToasts(prev => [...prev, { id, message, type, onClick: options?.onClick }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, options?.durationMs ?? 4000);
  }, []);

  const typeStyles: Record<string, { border: string; color: string }> = {
    success: { border: tokens.colors.successLight, color: tokens.colors.successLight },
    error: { border: tokens.colors.danger, color: tokens.colors.danger },
    info: { border: tokens.colors.info, color: tokens.colors.info },
  };

  const [muteHovered, setMuteHovered] = useState(false);

  return (
    <ToastContext.Provider value={{ showToast, muted, toggleMute, playNotifySound }}>
      {children}
      <div style={{
        position: 'fixed', bottom: 20, right: 20, zIndex: 9999,
        display: 'flex', flexDirection: 'column', gap: 8,
        pointerEvents: 'none',
      }}>
        {/* Mute toggle button */}
        <div style={{ pointerEvents: 'auto', alignSelf: 'flex-end' }}>
          <button
            onClick={toggleMute}
            aria-label={muted ? 'Unmute notifications' : 'Mute notifications'}
            aria-pressed={muted}
            onMouseEnter={() => setMuteHovered(true)}
            onMouseLeave={() => setMuteHovered(false)}
            style={{
              width: 32,
              height: 32,
              background: tokens.colors.surfaceCard,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.lg,
              fontSize: 14,
              color: muteHovered ? tokens.colors.textPrimary : tokens.colors.textSecondary,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            {muted ? '\uD83D\uDD15' : '\uD83D\uDD14'}
          </button>
        </div>

        {/* Toast list */}
        {toasts.map(toast => {
          const s = typeStyles[toast.type] || typeStyles.info;
          const clickable = !!toast.onClick;
          const dismiss = () => setToasts(prev => prev.filter(t => t.id !== toast.id));
          return (
            <div
              key={toast.id}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? () => { toast.onClick?.(); dismiss(); } : undefined}
              onKeyDown={clickable ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toast.onClick?.();
                  dismiss();
                }
              } : undefined}
              style={{
                padding: '10px 16px', borderRadius: tokens.radii.lg,
                background: tokens.colors.surfaceCard, border: `1px solid ${s.border}`,
                color: s.color, fontSize: '13px', fontWeight: 500,
                boxShadow: tokens.shadows.dropdown,
                maxWidth: 360, pointerEvents: 'auto',
                cursor: clickable ? 'pointer' : 'default',
                textAlign: 'left',
              }}
            >
              {toast.type === 'error' && '\u26A0 '}
              {toast.type === 'success' && '\u2713 '}
              {toast.message}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
