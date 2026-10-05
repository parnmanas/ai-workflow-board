import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useAgentSessionsNav } from '../../hooks/useAgentSessionsNav';
import { tokens } from '../../tokens';
import type { VoiceConfigView, VoiceOperator, VoiceOptionView, VoiceTranscript } from '../../types';
import { loadVoiceConfig } from '../../voice/useVoice';
import { useVoiceOperators } from '../../voice/operator';
import OperatorDialog from '../../voice/OperatorDialog';
import VoiceSpeakerCard from './VoiceSpeakerCard';
import { useNotifications } from '../../contexts/NotificationContext';
import { NOTIFICATION_SOUNDS, notificationSoundClip, type NotificationSound } from '../../voice/notificationSound';
import { speechPlayer } from '../../voice/speechPlayer';
import { sessionPath } from '../sessions/sessionList.logic';
import { runtimeLabel } from '../sessions/sessionTranscript.logic';
import { startVoiceRecording, voiceRecordingSupported, type ActiveRecording } from '../../voice/recorder';
import { Button, Card, Input, Select, Textarea } from '../common';
import {
  DEFAULT_BLIND_SENTENCES,
  characterErrorRate,
  planBlindClips,
  summarizeBlindTest,
  type BlindClip,
  type TtsCandidate,
} from './voiceLab.logic';

/**
 * Admin → Voice. 음성 엔진 설정과 엔진 고르기(Voice lab)를 한 화면에 둔다 — docs/voice-operator.md.
 *
 * 품질이 기준이므로 본인 목소리와 본인 귀로 정한다: STT 는 같은 발화를 키가 있는 공급자 모두에
 * 보내 글자와 오류율(정답을 적으면)을 나란히 보고, TTS 는 같은 문장을 후보마다 합성해 문장마다
 * 순서를 섞은 A/B/C 로만 들려준 뒤 평점을 매기고 나서야 누구였는지 드러낸다.
 */

const STT_OPTIONS = [
  { value: 'none', label: 'Off' },
  { value: 'soniox', label: 'Soniox' },
  { value: 'elevenlabs', label: 'ElevenLabs Scribe' },
  { value: 'openai', label: 'OpenAI / OpenAI-compatible' },
  { value: 'local', label: 'Self-hosted (ragnar)' },
];
const TTS_OPTIONS = [
  { value: 'none', label: 'Off' },
  { value: 'elevenlabs', label: 'ElevenLabs' },
  { value: 'typecast', label: 'Typecast' },
  { value: 'azure', label: 'Azure Speech' },
  { value: 'google', label: 'Google Cloud TTS' },
  { value: 'openai', label: 'OpenAI / OpenAI-compatible' },
  { value: 'local', label: 'Self-hosted (ragnar)' },
];
const PROVIDER_KEYS: Array<{ key: string; label: string }> = [
  { key: 'voice.soniox.api_key', label: 'Soniox API key' },
  { key: 'voice.elevenlabs.api_key', label: 'ElevenLabs API key' },
  { key: 'voice.typecast.api_key', label: 'Typecast API key' },
  { key: 'voice.azure.api_key', label: 'Azure Speech key' },
  { key: 'voice.azure.region', label: 'Azure region' },
  { key: 'voice.google.api_key', label: 'Google Cloud API key' },
  { key: 'voice.openai.api_key', label: 'OpenAI API key' },
  { key: 'voice.openai.base_url', label: 'OpenAI base URL' },
  { key: 'voice.local.base_url', label: 'Self-hosted server URL' },
  { key: 'voice.local.api_key', label: 'Self-hosted server key' },
];

const sectionTitle: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 4 };
const sectionHint: React.CSSProperties = { fontSize: 12, color: tokens.colors.textMuted, marginBottom: 14, lineHeight: 1.5 };
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 };

function EngineBadge({ label, status }: { label: string; status: { provider: string; ready: boolean; error: string | null } | undefined }) {
  const ready = !!status?.ready;
  const off = !status || status.provider === 'none';
  const color = ready ? tokens.colors.success : off ? tokens.colors.textMuted : tokens.colors.warning;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: tokens.colors.textSecondary }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, marginTop: 5, flexShrink: 0 }} />
      <span>
        <strong style={{ color: tokens.colors.textPrimary }}>{label}</strong>{' '}
        {ready ? `${status!.provider} — ready` : off ? 'off' : `${status!.provider} — ${status!.error || 'not ready'}`}
      </span>
    </div>
  );
}

// ─── STT 비교 ────────────────────────────────────────────────────────────────

interface SttResult {
  key: string;
  provider: string;
  model?: string;
  label: string;
  transcript: VoiceTranscript | null;
  error: string | null;
}

function SttLab({ providers, onAdopt }: { providers: string[]; onAdopt: (provider: string, model: string) => void }) {
  const [localModels, setLocalModels] = useState<Array<{ id: string; name: string }>>([]);
  const [reference, setReference] = useState('');
  const [recording, setRecording] = useState<ActiveRecording | null>(null);
  const recordingRef = useRef<ActiveRecording | null>(null);
  const [audio, setAudio] = useState<{ blob: Blob; url: string } | null>(null);
  const [results, setResults] = useState<SttResult[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!providers.includes('local')) return;
    let alive = true;
    void api.voiceLocalModels().then((out) => { if (alive) setLocalModels(out.models); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [providers]);
  const candidates = useMemo(() => providers.flatMap((provider) => provider === 'local' && localModels.length
    ? localModels.map((m) => ({ key: `local:${m.id}`, provider, model: m.id, label: m.name }))
    : [{ key: provider, provider, model: '', label: provider }]), [providers, localModels]);

  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url); }, [audio]);
  useEffect(() => () => recordingRef.current?.cancel(), []);

  const run = useCallback(async (blob: Blob) => {
    setRunning(true);
    setResults(candidates.map((candidate) => ({ ...candidate, transcript: null, error: null })));
    await Promise.all(candidates.map(async ({ key, provider, model }) => {
      try {
        const transcript = await api.voiceLabTranscribe(provider, blob, model || undefined);
        setResults((prev) => prev.map((r) => (r.key === key ? { ...r, transcript } : r)));
      } catch (err: any) {
        setResults((prev) => prev.map((r) => (r.key === key ? { ...r, error: err?.message || 'failed' } : r)));
      }
    }));
    setRunning(false);
  }, [candidates]);

  const toggle = useCallback(async () => {
    setError(null);
    if (recording) {
      recordingRef.current = null;
      setRecording(null);
      try {
        const out = await recording.stop();
        if (audio) URL.revokeObjectURL(audio.url);
        setAudio({ blob: out.blob, url: URL.createObjectURL(out.blob) });
        await run(out.blob);
      } catch (err: any) {
        setError(err?.message || 'Recording failed');
      }
      return;
    }
    try {
      const next = await startVoiceRecording();
      recordingRef.current = next;
      setRecording(next);
    } catch (err: any) {
      setError(err?.name === 'NotAllowedError' ? 'Microphone permission denied.' : (err?.message || 'Could not open the microphone'));
    }
  }, [recording, audio, run]);

  return (
    <Card padding="20px">
      <div style={sectionTitle}>Speech-to-text comparison</div>
      <div style={sectionHint}>
        Record one utterance the way you will really talk — Korean with English terms and host names mixed in — and it
        goes to every provider that has a key. Type what you actually said to get a character error rate; spacing and
        punctuation are ignored, an English term written in Hangul counts as wrong.
      </div>
      {providers.length === 0 ? (
        <div style={{ fontSize: 12.5, color: tokens.colors.textMuted }}>Add at least one speech-to-text API key above, save, and come back.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input label="What you said (optional — enables CER)" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="롤프의 agent-manager 상태 알려줘" />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant={recording ? 'danger' : 'primary'} size="sm" onClick={() => void toggle()} disabled={running || !voiceRecordingSupported()}>
              {recording ? '■ Stop and transcribe' : '🎙 Record'}
            </Button>
            {audio && !recording && (
              <>
                <audio src={audio.url} controls style={{ height: 32 }} />
                <Button variant="ghost" size="sm" onClick={() => void run(audio.blob)} disabled={running}>Run again</Button>
              </>
            )}
            <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>{providers.join(' · ')}</span>
          </div>
          {error && <div style={{ fontSize: 12, color: tokens.colors.warning }}>{error}</div>}
          {results.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: tokens.colors.textMuted, textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>Provider</th>
                  <th style={{ padding: '6px 8px' }}>Transcript</th>
                  <th style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>CER</th>
                  <th style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>Latency</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const cer = r.transcript && reference.trim() ? characterErrorRate(reference, r.transcript.text) : null;
                  return (
                    <tr key={r.key} style={{ borderTop: `1px solid ${tokens.colors.border}`, verticalAlign: 'top' }}>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', color: tokens.colors.textPrimary }}>
                        {r.label}
                        {r.transcript && <Button size="sm" variant="ghost" onClick={() => onAdopt(r.provider, r.model || '')}>Use this engine</Button>}
                        {r.transcript?.model && <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>{r.transcript.model}</div>}
                      </td>
                      <td style={{ padding: '6px 8px', color: r.error ? tokens.colors.warning : tokens.colors.textPrimary }}>
                        {r.error ? r.error : r.transcript ? (r.transcript.text || '(nothing recognised)') : 'Transcribing…'}
                      </td>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{cer === null ? '—' : `${(cer * 100).toFixed(1)}%`}</td>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{r.transcript ? `${r.transcript.latency_ms} ms` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── TTS 블라인드 테스트 ─────────────────────────────────────────────────────

let candidateSeq = 0;
const newCandidateKey = () => `c${++candidateSeq}`;

function CandidateRow({ candidate, providers, onChange, onRemove }: {
  candidate: TtsCandidate;
  providers: string[];
  onChange: (next: TtsCandidate) => void;
  onRemove: () => void;
}) {
  const { showToast } = useToast();
  const [voices, setVoices] = useState<VoiceOptionView[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadVoices = async () => {
    setLoading(true);
    try {
      const { voices: list } = await api.voiceLabVoices(candidate.provider);
      setVoices(list);
      if (list.length === 0) showToast(`${candidate.provider} does not list voices — type the voice id.`, 'info');
    } catch (err: any) {
      showToast(err?.message || 'Failed to list voices', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr 140px auto auto', gap: 8, alignItems: 'end' }}>
      <Select
        label="Provider"
        value={candidate.provider}
        options={providers.map((p) => ({ value: p, label: p }))}
        onChange={(e) => { setVoices(null); onChange({ ...candidate, provider: e.target.value, voice: '' }); }}
      />
      {voices && voices.length > 0 ? (
        <Select
          label="Voice"
          value={candidate.voice}
          placeholder="Pick a voice…"
          options={voices.map((v) => ({ value: v.id, label: [v.name, v.language, v.gender].filter(Boolean).join(' · ') }))}
          onChange={(e) => onChange({ ...candidate, voice: e.target.value })}
        />
      ) : (
        <Input label="Voice" value={candidate.voice} onChange={(e) => onChange({ ...candidate, voice: e.target.value })} placeholder="voice id / name" />
      )}
      <Input label="Model" value={candidate.model} onChange={(e) => onChange({ ...candidate, model: e.target.value })} placeholder="default" />
      <Button variant="ghost" size="sm" onClick={() => void loadVoices()} disabled={loading}>{loading ? 'Loading…' : 'Voices'}</Button>
      <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remove candidate">×</Button>
    </div>
  );
}

function TtsBlindTest({ providers, configured, onAdopt }: {
  providers: string[];
  configured: { provider: string; voice: string; model: string };
  onAdopt: (candidate: TtsCandidate) => void;
}) {
  const { showToast } = useToast();
  const [candidates, setCandidates] = useState<TtsCandidate[]>([]);
  const [sentences, setSentences] = useState(DEFAULT_BLIND_SENTENCES);
  const [clips, setClips] = useState<BlindClip[]>([]);
  const [running, setRunning] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const playingRef = useRef<HTMLAudioElement | null>(null);

  // 처음 열 때 키가 있는 공급자마다 후보 하나 — 지금 설정된 목소리는 그 공급자 줄에 채워 둔다.
  useEffect(() => {
    setCandidates((prev) => (prev.length ? prev : providers.map((provider) => ({
      key: newCandidateKey(),
      provider,
      voice: provider === configured.provider ? configured.voice : '',
      model: provider === configured.provider ? configured.model : '',
    }))));
  }, [providers, configured.provider, configured.voice, configured.model]);

  useEffect(() => () => {
    playingRef.current?.pause();
    for (const clip of clips) if (clip.url) URL.revokeObjectURL(clip.url);
  }, [clips]);

  const lines = useMemo(() => sentences.split('\n').map((s) => s.trim()).filter(Boolean), [sentences]);

  const generate = async () => {
    const usable = candidates.filter((c) => c.provider);
    if (!usable.length || !lines.length) return;
    setRevealed(false);
    const plan = planBlindClips(lines.length, usable);
    setClips(plan);
    setRunning(true);
    // 공급자 쿼터(Azure F0 = 분당 20건)를 넘지 않게 하나씩.
    for (let i = 0; i < plan.length; i++) {
      const clip = plan[i];
      const candidate = usable.find((c) => c.key === clip.candidateKey)!;
      try {
        const { blob, latencyMs } = await api.voiceLabSpeech({
          provider: candidate.provider,
          text: lines[clip.sentenceIndex],
          voice: candidate.voice || undefined,
          model: candidate.model || undefined,
        });
        const url = URL.createObjectURL(blob);
        setClips((prev) => prev.map((c, j) => (j === i ? { ...c, url, latencyMs } : c)));
      } catch (err: any) {
        setClips((prev) => prev.map((c, j) => (j === i ? { ...c, error: err?.message || 'failed' } : c)));
      }
    }
    setRunning(false);
  };

  const play = (url: string) => {
    playingRef.current?.pause();
    const el = new Audio(url);
    playingRef.current = el;
    el.play().catch((err) => showToast(err?.message || 'Playback failed', 'error'));
  };

  const rate = (index: number, rating: number | null) => setClips((prev) => prev.map((c, i) => (i === index ? { ...c, rating } : c)));
  const summary = useMemo(() => summarizeBlindTest(clips, candidates), [clips, candidates]);
  const describe = (key: string) => {
    const c = candidates.find((x) => x.key === key);
    return c ? `${c.provider}${c.voice ? ` · ${c.voice}` : ''}${c.model ? ` · ${c.model}` : ''}` : key;
  };

  return (
    <Card padding="20px">
      <div style={sectionTitle}>Text-to-speech blind test</div>
      <div style={sectionHint}>
        Every sentence is synthesised by every candidate, then shown only as A / B / C — shuffled again for each
        sentence, so position gives nothing away. Rate what you hear, then reveal. There is no independent Korean
        naturalness benchmark, so this is the deciding test.
      </div>
      {providers.length === 0 ? (
        <div style={{ fontSize: 12.5, color: tokens.colors.textMuted }}>Add at least one text-to-speech API key above, save, and come back.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {candidates.map((c) => (
            <CandidateRow
              key={c.key}
              candidate={c}
              providers={providers}
              onChange={(next) => setCandidates((prev) => prev.map((x) => (x.key === c.key ? next : x)))}
              onRemove={() => setCandidates((prev) => prev.filter((x) => x.key !== c.key))}
            />
          ))}
          <div>
            <Button variant="ghost" size="sm" onClick={() => setCandidates((prev) => [...prev, { key: newCandidateKey(), provider: providers[0], voice: '', model: '' }])}>
              + Candidate
            </Button>
          </div>
          <Textarea label="Sentences (one per line)" value={sentences} onChange={(e) => setSentences(e.target.value)} rows={5} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button variant="primary" size="sm" onClick={() => void generate()} disabled={running || !candidates.length || !lines.length}>
              {running ? 'Synthesising…' : 'Generate clips'}
            </Button>
            {clips.length > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setRevealed((r) => !r)}>{revealed ? 'Hide' : 'Reveal'}</Button>
            )}
          </div>

          {lines.map((line, s) => {
            const mine = clips.map((c, i) => ({ c, i })).filter(({ c }) => c.sentenceIndex === s);
            if (!mine.length) return null;
            return (
              <div key={s} style={{ borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 10 }}>
                <div style={{ fontSize: 12.5, color: tokens.colors.textPrimary, marginBottom: 8 }}>{line}</div>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {mine.map(({ c, i }) => (
                    <div key={`${c.sentenceIndex}-${c.label}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Button variant="secondary" size="sm" disabled={!c.url} onClick={() => c.url && play(c.url)} title={c.error || undefined}>
                        ▶ {c.label}{c.error ? ' ⚠' : !c.url ? ' …' : ''}
                      </Button>
                      <select
                        aria-label={`Rating for ${c.label}`}
                        value={c.rating ?? ''}
                        onChange={(e) => rate(i, e.target.value ? Number(e.target.value) : null)}
                        style={{ padding: '3px 6px', borderRadius: tokens.radii.sm, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12 }}
                      >
                        <option value="">–</option>
                        {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                      {revealed && <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>{describe(c.candidateKey)}{c.latencyMs ? ` · ${c.latencyMs} ms` : ''}</span>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {revealed && summary.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginTop: 6 }}>
              <thead>
                <tr style={{ color: tokens.colors.textMuted, textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>Candidate</th>
                  <th style={{ padding: '6px 8px' }}>Avg rating</th>
                  <th style={{ padding: '6px 8px' }}>Avg latency</th>
                  <th style={{ padding: '6px 8px' }}>Failures</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {summary.map((row) => (
                  <tr key={row.candidateKey} style={{ borderTop: `1px solid ${tokens.colors.border}` }}>
                    <td style={{ padding: '6px 8px', color: tokens.colors.textPrimary }}>{describe(row.candidateKey)}</td>
                    <td style={{ padding: '6px 8px' }}>{row.averageRating === null ? '—' : `${row.averageRating.toFixed(2)} (${row.rated})`}</td>
                    <td style={{ padding: '6px 8px' }}>{row.averageLatencyMs === null ? '—' : `${Math.round(row.averageLatencyMs)} ms`}</td>
                    <td style={{ padding: '6px 8px' }}>{row.failures}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      <Button variant="ghost" size="sm" onClick={() => {
                        const c = candidates.find((x) => x.key === row.candidateKey);
                        if (c) onAdopt(c);
                      }}>Use this voice</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── 페이지 ─────────────────────────────────────────────────────────────────

/**
 * Operators — 이름 붙은 세션들(docs/voice-operator.md "Operator"). 등록은 세션 화면의 ☆ Operator 에서 한다
 * (그 세션에 지침을 보내야 해서). 여기서는 이름·별칭을 고치고, 장비에서 사라진 세션의 등록을 푼다.
 */
function OperatorsCard({ wake }: { wake: VoiceConfigView['wake'] | undefined }) {
  const operators = useVoiceOperators(true);
  const { currentWorkspaceId } = useAuth();
  const { hosts } = useAgentSessionsNav(currentWorkspaceId ?? null);
  const navigate = useNavigate();
  const [editing, setEditing] = useState<VoiceOperator | null>(null);
  const hostName = (id: string) => hosts.find((h) => h.manager_id === id)?.name || id.slice(0, 8);
  return (
    <Card padding="20px">
      <div style={sectionTitle}>Operators</div>
      <div style={sectionHint}>
        Agent sessions with a name. Switch on name calling in the sidebar (OPERATORS → 👂) and say "헤이 &lt;name&gt;" or
        "&lt;name&gt;야" — the operator wakes, keeps listening without its name, and goes back to sleep when it decides the
        conversation is over. Register one from a session's header (☆ Operator).
        {wake && !wake.ready && wake.error ? <><br /><span style={{ color: tokens.colors.warningLight }}>{wake.error}</span></> : null}
      </div>
      {operators.length === 0 ? (
        <div style={{ fontSize: 12.5, color: tokens.colors.textMuted }}>No operator yet — open a session and press ☆ Operator.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {operators.map((op) => (
            <div key={op.id} data-operator-id={op.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: tokens.colors.textPrimary }}>🎙 {op.name}</div>
                <div style={{ fontSize: 11.5, color: tokens.colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {op.aliases.length ? `also: ${op.aliases.join(', ')} · ` : ''}{hostName(op.manager_id)} · {runtimeLabel(op.cli)}{op.title ? ` · ${op.title}` : ''}
                </div>
              </div>
              {currentWorkspaceId && (
                <Button variant="ghost" size="sm" onClick={() => navigate(sessionPath(`/ws/${currentWorkspaceId}`, op.manager_id, op.cli, op.session_id))}>Open</Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => setEditing(op)}>Edit</Button>
            </div>
          ))}
        </div>
      )}
      <OperatorDialog open={!!editing} operator={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

export default function VoicePage() {
  const { showToast } = useToast();
  const { prefs, setPref } = useNotifications();
  const [values, setValues] = useState<Record<string, string>>({});
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<VoiceConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, config] = await Promise.all([api.getSettings(), loadVoiceConfig(true)]);
      const vals: Record<string, string> = {};
      const desc: Record<string, string> = {};
      for (const row of rows) {
        if (!row.key.startsWith('voice.')) continue;
        vals[row.key] = row.value;
        desc[row.key] = row.description;
      }
      setValues(vals);
      setDescriptions(desc);
      setStatus(config);
      setDirty(false);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load voice settings', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  const set = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.updateSettings(values);
      showToast('Voice settings saved.', 'success');
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>Loading…</div>;

  const field = (key: string, label: string, opts: { secret?: boolean; placeholder?: string } = {}) => (
    <div key={key}>
      <Input
        label={label}
        type={opts.secret ? 'password' : 'text'}
        autoComplete="off"
        value={values[key] ?? ''}
        placeholder={opts.placeholder}
        onChange={(e) => set(key, e.target.value)}
      />
      {descriptions[key] && <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4 }}>{descriptions[key]}</div>}
    </div>
  );

  return (
    <div style={{ maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card padding="20px">
        <div style={sectionTitle}>Engines</div>
        <div style={sectionHint}>
          Voice input sends your recording to the speech-to-text provider; spoken replies and announcements come from the
          text-to-speech provider. Keys stay on the server. Pick the providers with the lab below — quality first.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
          <EngineBadge label="Speech-to-text:" status={status?.stt} />
          <EngineBadge label="Text-to-speech:" status={status?.tts} />
        </div>
        <div style={grid2}>
          <Select label="Speech-to-text provider" value={values['voice.stt.provider'] || 'none'} options={STT_OPTIONS} onChange={(e) => set('voice.stt.provider', e.target.value)} />
          {field('voice.stt.model', 'STT model', { placeholder: 'provider default' })}
          <Select label="Text-to-speech provider" value={values['voice.tts.provider'] || 'none'} options={TTS_OPTIONS} onChange={(e) => set('voice.tts.provider', e.target.value)} />
          {field('voice.tts.voice', 'TTS voice')}
          {field('voice.tts.model', 'TTS model', { placeholder: 'provider default' })}
          {field('voice.stt.languages', 'Languages')}
        </div>
        <div style={{ marginTop: 12 }}>{field('voice.stt.terms', 'Vocabulary (comma-separated)')}</div>
        <div style={{ ...sectionTitle, fontSize: 13, marginTop: 20 }}>Provider keys</div>
        <div style={grid2}>
          {PROVIDER_KEYS.map(({ key, label }) => field(key, label, { secret: key.endsWith('.api_key') }))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </Card>

      <OperatorsCard wake={status?.wake} />

      <Card padding="20px">
        <div style={sectionTitle}>Work update sound</div>
        <div style={sectionHint}>The operator keeps work reports and plays a short cue. Ask the operator for details when you want to hear them. This choice applies to this browser.</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
          <Select label="Notification sound" value={prefs.workSound} options={NOTIFICATION_SOUNDS.map((s) => ({ value: s.value, label: s.label }))} onChange={(e) => setPref('workSound', e.target.value as NotificationSound)} />
          <Button size="sm" variant="ghost" onClick={() => { speechPlayer.unlock(); speechPlayer.enqueueClip(async () => notificationSoundClip(prefs.workSound), 'sound-preview'); }}>Preview</Button>
          <label style={{ fontSize: 12 }}><input type="checkbox" checked={prefs.voice} onChange={(e) => setPref('voice', e.target.checked)} /> Work updates</label>
          <label style={{ fontSize: 12 }}><input type="checkbox" checked={prefs.audio} onChange={(e) => setPref('audio', e.target.checked)} /> Audio cues</label>
        </div>
      </Card>

      <VoiceSpeakerCard />

      <SttLab providers={status?.lab?.stt ?? []} onAdopt={(provider, model) => {
        set('voice.stt.provider', provider); set('voice.stt.model', model);
        showToast('Filled in the speech-to-text settings — Save to apply.', 'info');
      }} />

      <TtsBlindTest
        providers={status?.lab?.tts ?? []}
        configured={{ provider: values['voice.tts.provider'] || '', voice: values['voice.tts.voice'] || '', model: values['voice.tts.model'] || '' }}
        onAdopt={(c) => {
          set('voice.tts.provider', c.provider);
          set('voice.tts.voice', c.voice);
          set('voice.tts.model', c.model);
          showToast('Filled in the engine settings — Save to apply.', 'info');
        }}
      />
    </div>
  );
}
