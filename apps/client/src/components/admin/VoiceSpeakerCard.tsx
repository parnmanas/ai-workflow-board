import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { VoiceSpeakerProfile, VoiceTranscript } from '../../types';
import { startVoiceRecording, voiceRecordingSupported, type ActiveRecording } from '../../voice/recorder';
import { wakeStore } from '../../voice/wakeState';
import { speechPlayer } from '../../voice/speechPlayer';
import { Button, Card } from '../common';

export default function VoiceSpeakerCard() {
  const [profile, setProfile] = useState<VoiceSpeakerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'enroll' | 'test' | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<VoiceTranscript | null>(null);
  const active = useRef<ActiveRecording | null>(null);
  const releaseMic = useRef<(() => void) | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void api.getVoiceSpeaker().then((p) => { if (alive.current) setProfile(p); }).catch((e) => { if (alive.current) setError(e.message); });
    return () => { alive.current = false; active.current?.cancel(); releaseMic.current?.(); };
  }, []);

  const finish = async (kind: 'enroll' | 'test') => {
    const recording = active.current;
    if (!recording) return;
    active.current = null;
    setMode(null);
    setBusy(true);
    try {
      const out = await recording.stop();
      if (kind === 'enroll') {
        const next = await api.enrollVoiceSpeaker(out.blob);
        if (alive.current) setProfile(next);
      } else {
        const next = await api.transcribeVoice(out.blob);
        if (alive.current) setResult(next);
      }
    } catch (e: any) {
      if (alive.current) setError(e.message || 'Could not process your voice.');
    } finally {
      releaseMic.current?.(); releaseMic.current = null;
      if (alive.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (!mode) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
      if (Date.now() - started >= 20000) void finish(mode);
    }, 250);
    return () => window.clearInterval(timer);
  }, [mode]);

  const record = async (kind: 'enroll' | 'test') => {
    setError(null); setResult(null); setBusy(true);
    speechPlayer.stop();
    releaseMic.current = wakeStore.claimMic();
    try {
      const recording = await startVoiceRecording(() => void finish(kind));
      if (!alive.current) { recording.cancel(); releaseMic.current?.(); releaseMic.current = null; return; }
      active.current = recording; setElapsed(0); setMode(kind);
    } catch (e: any) {
      releaseMic.current?.(); releaseMic.current = null;
      setError(e.message || 'Could not open the microphone.');
    } finally { if (alive.current) setBusy(false); }
  };

  const change = async (run: () => Promise<VoiceSpeakerProfile>) => {
    setError(null); setBusy(true);
    try { setProfile(await run()); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return <Card padding="20px">
    <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>My voice</div>
    <p style={{ fontSize: 12, color: tokens.colors.textMuted, lineHeight: 1.6 }}>
      Sample your voice in a quiet room. Only matching speech is sent to recognition, including calling an operator by name.
      Record 2–3 samples in Korean and English using your usual microphone. Changes apply immediately to your account.
      Recordings are discarded; encrypted voice features are stored until you delete them.
    </p>
    <blockquote style={{ fontSize: 13, lineHeight: 1.7, margin: '12px 0', color: tokens.colors.textSecondary }}>
      안녕하세요. 내 목소리로 작업 상태를 확인하고 싶어요. 헤이 자비스, 라그나르의 작업 결과를 알려줘.
      Please check the agent manager and explain the workflow board status.
    </blockquote>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button size="sm" variant={mode ? 'danger' : 'primary'} disabled={busy || !voiceRecordingSupported()} onClick={() => void (mode ? finish(mode) : record('enroll'))}>
        {mode ? `Stop (${elapsed}s)` : profile?.enrolled ? 'Add voice sample' : 'Sample my voice'}
      </Button>
      <span style={{ fontSize: 12 }}>{profile ? `${profile.samples}/5 samples · ${profile.enabled ? 'filter enabled' : 'filter off'}` : 'Loading…'}</span>
      {profile?.enrolled && <>
        <Button size="sm" variant="ghost" disabled={busy || !!mode} onClick={() => void change(() => api.updateVoiceSpeaker({ enabled: !profile.enabled }))}>{profile.enabled ? 'Disable filter' : 'Enable filter'}</Button>
        <Button size="sm" variant="ghost" disabled={busy || !!mode || !profile.enabled} onClick={() => void record('test')}>Test recognition</Button>
        <Button size="sm" variant="danger" disabled={busy || !!mode} onClick={() => void change(() => api.removeVoiceSpeaker())}>Delete my samples</Button>
      </>}
    </div>
    {profile?.enrolled && <label style={{ display: 'block', fontSize: 12, marginTop: 16 }}>
      Voice match threshold
      <select style={{ marginLeft: 12 }} value={profile.threshold} disabled={busy || !!mode} onChange={(e) => void change(() => api.updateVoiceSpeaker({ threshold: Number(e.target.value) }))}>
        {[...new Set([0.45, 0.6, 0.75, profile.threshold])].sort().map((t) => <option key={t} value={t}>{t === 0.45 ? 'Forgiving (0.45)' : t === 0.6 ? 'Balanced (0.60)' : t === 0.75 ? 'Strict (0.75)' : t}</option>)}
      </select>
    </label>}
    <p style={{ fontSize: 12, color: tokens.colors.textMuted }}>If your voice is missed, add a sample or lower the threshold. Simultaneous voices and very short words can be difficult to distinguish.</p>
    {result && <div style={{ fontSize: 13 }}>
      {result.ignored ? `Ignored: ${result.ignored}` : result.text || 'No words recognized.'}
      {result.speaker_score !== undefined && ` · voice match ${result.speaker_score.toFixed(2)}`} · {result.latency_ms} ms
    </div>}
    {error && <div role="alert" style={{ marginTop: 10, fontSize: 12, color: tokens.colors.warning }}>{error}</div>}
  </Card>;
}
