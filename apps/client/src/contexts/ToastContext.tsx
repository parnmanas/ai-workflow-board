import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { tokens } from '../tokens';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastContextType {
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
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

  // Mute state persisted in localStorage
  const [muted, setMuted] = useState<boolean>(() => localStorage.getItem('chat_notify_muted') === 'true');
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
    setMuted(prev => {
      const next = !prev;
      localStorage.setItem('chat_notify_muted', String(next));
      return next;
    });
  }, []);

  const playNotifySound = useCallback(() => {
    if (!muted && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
    }
  }, [muted]);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = ++nextIdRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
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
          return (
            <div key={toast.id} style={{
              padding: '10px 16px', borderRadius: tokens.radii.lg,
              background: tokens.colors.surfaceCard, border: `1px solid ${s.border}`,
              color: s.color, fontSize: '13px', fontWeight: 500,
              boxShadow: tokens.shadows.dropdown,
              maxWidth: 360, pointerEvents: 'auto',
            }}>
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
