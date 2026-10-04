# AWB voice server (self-hosted STT/TTS)

The speech engines AWB's `local` voice adapter calls
(`apps/server/src/modules/voice/providers/local.ts`). It runs on a GPU host on the
LAN — today **ragnar** (DGX Spark class: aarch64, NVIDIA GB10, unified memory,
driver 580 / CUDA 13). Design and rationale: `docs/voice-operator.md` →
"셀프호스팅 엔진".

```
AWB server (rolf) ──LAN, Bearer key──▶ awb-voice-gateway :8410  (this repo: awb_voice_server.py)
                                         ├─▶ awb-voice-asr  127.0.0.1:8411  vLLM + Qwen/Qwen3-ASR-1.7B
                                         └─▶ awb-voice-tts  127.0.0.1:8421  vLLM-Omni + Qwen3-TTS-12Hz-1.7B-CustomVoice
```

| Piece | What | How it runs |
|---|---|---|
| `awb-voice-asr` | Qwen3-ASR-1.7B (Apache-2.0) on vLLM 0.25.1 | systemd **user** unit, venv `~/.venvs/voice-asr` (a copy of the host's working vLLM venv + librosa/soundfile/av) |
| `awb-voice-tts` | Qwen3-TTS-12Hz-1.7B-CustomVoice (Apache-2.0), voice `sohee` | Docker `vllm/vllm-omni:v0.30.0` (arm64), `--restart unless-stopped`; `tts-container.sh` |
| `awb-voice-gateway` | the only LAN-facing piece: bearer-key auth, any browser recording → 16 kHz WAV (PyAV bundles FFmpeg), TTS WAV → MP3, voice catalog | systemd **user** unit, uvicorn |

Model servers listen on localhost only. Both model servers share the GPU with
the host's own LLM (`vllm-qwen3-coder-next-optimized`, 0.48 of memory) — their
memory fractions are deliberately small (ASR 0.08, TTS stages 0.06 + 0.04).

## API (what the AWB adapter speaks)

| | |
|---|---|
| `POST /v1/audio/transcriptions` | multipart `file` (webm/opus, mp4/aac, ogg, wav, mp3…), `[language]` (`ko`), `[prompt]` (vocabulary → Qwen3-ASR context) → `{ text, duration, latency_ms }` |
| `POST /v1/audio/speech` | `{ input, [voice], [language], [response_format: mp3\|wav] }` → audio (MP3 by default) |
| `GET /v1/audio/voices` | `{ voices: [{ id, name, language, gender }], default }` — from `voices.json` |
| `GET /health` | `{ ok, stt: { ready }, tts: { ready } }` — open (no key), 503 until both backends answer |

Every route but `/health` needs `Authorization: Bearer $AWB_VOICE_KEY`.

## Install / update (on the GPU host)

```bash
./install.sh   # copies files to ~/voice-server, writes ~/.config/awb-voice/env (new key) once,
               # enables awb-voice-asr + awb-voice-gateway, creates the TTS container if missing
```

Then in AWB → Admin → Voice: provider **Self-hosted (ragnar)**, server URL
`http://<host>:8410/v1`, key = `AWB_VOICE_KEY` from `~/.config/awb-voice/env`.

Voices: edit `voices.json` (speaker, language, optional `instructions` style
prompt for the 1.7B CustomVoice model) and restart the gateway — no AWB change.

## Gotchas
- FlashInfer JIT-compiles kernels on first start: the ASR unit puts the venv's
  `ninja` and the Python headers on its environment, like the host's LLM unit.
- NGC vLLM containers newer than 26.02 refuse driver 580 — the upstream
  `vllm/vllm-omni` image (CUDA 13.0.2) runs natively.
- Qwen3-TTS takes full language names (`Korean`), not `ko`; the gateway maps them.
- Qwen3-TTS can swallow the last Korean syllable (QwenLM/Qwen3-TTS#55); the
  gateway ends every input on punctuation.
