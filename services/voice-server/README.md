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
| `GET /v1/audio/models` | Installed STT model choices and speaker availability; used by Voice lab |
| `POST /v1/audio/speaker/embedding` | multipart `file` → `{ embedding, model, speech_seconds }`; requires ≥6 seconds of speech; no recording stored |
| `POST /v1/audio/speaker/filter` | multipart `file`, `profile` (JSON model + reference vectors), `threshold` → matching speech as WAV with `X-Speaker-Accepted: true`, or 204 + `X-Speaker-Ignored`; does not store profiles |

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

## Speaker filtering and alternative STT

```bash
./install-tools.sh  # isolated ~/.venvs/voice-tools; CPU speaker model + Whisper download
./install.sh        # copy the gateway + speaker_filter.py and restart only the gateway
```

The optional systemd drop-in switches the gateway interpreter to `voice-tools`,
leaving the working vLLM ASR environment and GPU allocation intact. The models
are `3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx` (Sherpa ONNX) and
`large-v3-turbo` (faster-whisper, CPU/int8). The gateway still defaults to Qwen;
`model=whisper-large-v3-turbo` explicitly selects the comparison engine. An
unknown model is rejected rather than silently selecting another engine.

The speaker filter runs Silero VAD, compares windows of at most two seconds to
the user's reference embeddings and discards nonmatching windows before any
STT request. Profiles live encrypted in AWB, scoped to the authenticated user;
this gateway retains neither profiles nor recordings. The model fingerprint
is checked to prevent applying old embeddings to a replacement model. Samples
with insufficient speech, clipping, or inconsistent speakers are rejected.
Very short or overlapping speech still needs real-user testing and threshold
tuning. This is an input filter, not identity authentication.

In AWB → VOICE, enroll 2–3 samples under **My voice**, and compare the same
Korean/English recording under **Speech-to-text comparison**. Multiple language
hints (`ko,en`) use automatic detection rather than forcing Korean. The CPU
Whisper option is intended for accuracy comparison and can be considerably
slower than Qwen on the GPU; do not switch based on synthetic audio alone.

Validation:

```bash
~/.venvs/voice-tools/bin/python -m unittest test_voice_server -v
```

Primary model/API references: [Sherpa speaker identification](https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html),
[faster-whisper](https://github.com/SYSTRAN/faster-whisper),
[Qwen language forcing](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py).

To remove the optional interpreter override, remove
`~/.config/systemd/user/awb-voice-gateway.service.d/tools.conf`, then run
`systemctl --user daemon-reload` and `systemctl --user restart awb-voice-gateway`.
Disable enrolled speaker filters in AWB first; enabled filters fail explicitly
when their engine is unavailable.

## Gotchas
- FlashInfer JIT-compiles kernels on first start: the ASR unit puts the venv's
  `ninja` and the Python headers on its environment, like the host's LLM unit.
- NGC vLLM containers newer than 26.02 refuse driver 580 — the upstream
  `vllm/vllm-omni` image (CUDA 13.0.2) runs natively.
- Qwen3-TTS takes full language names (`Korean`), not `ko`; the gateway maps them.
- Qwen3-TTS can swallow the last Korean syllable (QwenLM/Qwen3-TTS#55); the
  gateway ends every input on punctuation.
