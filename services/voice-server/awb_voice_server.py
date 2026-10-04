"""AWB voice server — self-hosted speech-to-text and text-to-speech for AWB.

docs/voice-operator.md "셀프호스팅 엔진". AWB's `local` voice adapter
(apps/server/src/modules/voice/providers/local.ts) speaks this surface:

  POST /v1/audio/transcriptions  multipart: file, [model], [language], [prompt]  -> {"text": "..."}
  POST /v1/audio/speech          JSON {input, [voice], [model], [response_format: mp3|wav], [language]}
                                  -> audio bytes
  GET  /v1/audio/voices          -> {"voices": [{id, name, language, gender}], "default": id}
  GET  /health                   -> {"ok": bool, "stt": {...}, "tts": {...}}

Auth: `Authorization: Bearer $AWB_VOICE_KEY` when that variable is set.

The models run in their own servers on localhost only; this process is the one
thing exposed on the LAN. It owns the two jobs the model servers should not care
about:
  * audio in: the browser records webm/opus (Chrome, Android WebView) or mp4/aac
    (Safari). Everything is decoded here (PyAV bundles FFmpeg — no system ffmpeg)
    into 16 kHz mono WAV before the ASR model sees it.
  * audio out: TTS models emit PCM/WAV; AWB plays MP3, so it is encoded here.
"""

from __future__ import annotations

import hmac
import io
import json
import os
import re
import time
from typing import Any

import av
import httpx
import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response

ASR_URL = os.environ.get("ASR_URL", "http://127.0.0.1:8411/v1").rstrip("/")
ASR_MODEL = os.environ.get("ASR_MODEL", "qwen3-asr")
TTS_URL = os.environ.get("TTS_URL", "http://127.0.0.1:8421").rstrip("/")
TTS_MODEL = os.environ.get("TTS_MODEL", "")
VOICES_FILE = os.environ.get("VOICES_FILE", os.path.join(os.path.dirname(__file__), "voices.json"))
API_KEY = os.environ.get("AWB_VOICE_KEY", "")
ASR_SAMPLE_RATE = 16_000
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
TIMEOUT = httpx.Timeout(120.0, connect=5.0)

app = FastAPI(title="AWB voice server")
client = httpx.AsyncClient(timeout=TIMEOUT)

@app.middleware("http")
async def require_key(request: Request, call_next):
    """Every route but /health needs the bearer key — checked before the body is
    parsed, so an unauthenticated caller learns nothing about the API shape."""
    if API_KEY and request.url.path != "/health":
        header = request.headers.get("authorization", "")
        if not hmac.compare_digest(header.encode(), f"Bearer {API_KEY}".encode()):
            return JSONResponse({"detail": "invalid or missing bearer key"}, status_code=401)
    return await call_next(request)


# ─── audio in ────────────────────────────────────────────────────────────────


def decode_to_mono(data: bytes, sample_rate: int = ASR_SAMPLE_RATE) -> np.ndarray:
    """Any container/codec FFmpeg knows -> float32 mono at `sample_rate`."""
    try:
        container = av.open(io.BytesIO(data))
    except av.error.FFmpegError as exc:  # type: ignore[attr-defined]
        raise HTTPException(status_code=400, detail=f"unreadable audio: {exc}") from exc
    resampler = av.AudioResampler(format="flt", layout="mono", rate=sample_rate)
    chunks: list[np.ndarray] = []
    with container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise HTTPException(status_code=400, detail="no audio stream in upload")
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        raise HTTPException(status_code=400, detail="empty audio")
    return np.concatenate(chunks).astype(np.float32)


def wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


async def asr_transcribe(audio: np.ndarray, language: str | None, prompt: str | None) -> str:
    """16 kHz WAV -> vLLM's transcription endpoint. vLLM builds Qwen3-ASR's own
    prompt from these fields (vllm/model_executor/models/qwen3_asr.py
    `get_generation_prompt`): `prompt` becomes the system context (hotwords),
    `language` the forced `language <Name><asr_text>` assistant prefix."""
    data: dict[str, str] = {"model": ASR_MODEL, "response_format": "json"}
    if language:
        data["language"] = language
    if prompt:
        data["prompt"] = prompt
    files = {"file": ("utterance.wav", wav_bytes(audio, ASR_SAMPLE_RATE), "audio/wav")}
    res = await client.post(f"{ASR_URL}/audio/transcriptions", data=data, files=files)
    if res.status_code != 200:
        raise HTTPException(status_code=502, detail=f"asr backend {res.status_code}: {res.text[:300]}")
    return str(res.json().get("text") or "").strip()


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    request: Request,
    file: UploadFile = File(...),
    model: str | None = Form(None),
    language: str | None = Form(None),
    prompt: str | None = Form(None),
    response_format: str | None = Form(None),
) -> JSONResponse:
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="audio too large")
    started = time.monotonic()
    audio = decode_to_mono(data)
    text = await asr_transcribe(audio, language, prompt)
    return JSONResponse({
        "text": text,
        "duration": round(len(audio) / ASR_SAMPLE_RATE, 2),
        "latency_ms": int((time.monotonic() - started) * 1000),
    })


# ─── audio out ───────────────────────────────────────────────────────────────


def load_voices() -> dict[str, Any]:
    try:
        with open(VOICES_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {"voices": [], "default": ""}


def encode_mp3(samples: np.ndarray, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with av.open(buf, mode="w", format="mp3") as out:
        stream = out.add_stream("libmp3lame", rate=sample_rate, layout="mono")
        stream.bit_rate = 64_000
        frame_size = 1152
        pcm = np.clip(samples, -1.0, 1.0).astype(np.float32)
        for start in range(0, len(pcm), frame_size * 32):
            chunk = pcm[start:start + frame_size * 32]
            frame = av.AudioFrame.from_ndarray(chunk.reshape(1, -1), format="flt", layout="mono")
            frame.sample_rate = sample_rate
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    return buf.getvalue()


def decode_any(data: bytes) -> tuple[np.ndarray, int]:
    """TTS backends answer WAV/PCM/other; return float32 mono at the native rate."""
    try:
        samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        return samples.mean(axis=1), int(rate)
    except Exception:  # not something libsndfile reads — let FFmpeg try
        container = av.open(io.BytesIO(data))
        stream = next(s for s in container.streams if s.type == "audio")
        rate = stream.rate or 24_000
        resampler = av.AudioResampler(format="flt", layout="mono", rate=rate)
        chunks = [o.to_ndarray().reshape(-1) for f in container.decode(stream) for o in resampler.resample(f)]
        return np.concatenate(chunks).astype(np.float32), rate


# Qwen3-TTS takes full language names (`Korean`), not ISO codes — `ko` is a 400.
TTS_LANGUAGE_NAMES = {"ko": "Korean", "en": "English", "ja": "Japanese", "zh": "Chinese"}


def speakable_tail(text: str) -> str:
    """Qwen3-TTS can swallow the last Korean syllable (QwenLM/Qwen3-TTS#55) — end
    every input on punctuation so the cut, if any, lands on silence."""
    text = text.strip()
    return text if re.search(r"[.!?。！？…]$", text) else f"{text}."


async def tts_backend(text: str, voice: dict[str, Any], language: str | None) -> tuple[np.ndarray, int]:
    """Ask the TTS model server (vLLM-Omni, OpenAI speech shape) for WAV. The
    voice-specific fields (speaker, language, style instructions) come from voices.json."""
    body: dict[str, Any] = {"input": speakable_tail(text), "response_format": "wav", **voice.get("request", {})}
    if TTS_MODEL and "model" not in body:
        body["model"] = TTS_MODEL
    if "language" not in body:
        body["language"] = TTS_LANGUAGE_NAMES.get((language or "").lower(), "Auto")
    res = await client.post(f"{TTS_URL}/v1/audio/speech", json=body)
    if res.status_code != 200:
        raise HTTPException(status_code=502, detail=f"tts backend {res.status_code}: {res.text[:300]}")
    return decode_any(res.content)


@app.get("/v1/audio/voices")
async def voices(request: Request) -> JSONResponse:
    catalog = load_voices()
    return JSONResponse({
        "voices": [{k: v for k, v in voice.items() if k != "request"} for voice in catalog.get("voices", [])],
        "default": catalog.get("default", ""),
    })


@app.post("/v1/audio/speech")
async def speech(request: Request) -> Response:
    body = await request.json()
    text = str(body.get("input") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="input is empty")
    catalog = load_voices()
    wanted = str(body.get("voice") or "default")
    if wanted == "default":
        wanted = catalog.get("default", "")
    voice = next((v for v in catalog.get("voices", []) if v.get("id") == wanted), None)
    if voice is None:
        raise HTTPException(status_code=400, detail=f"unknown voice {wanted!r} — see GET /v1/audio/voices")
    samples, rate = await tts_backend(text, voice, body.get("language"))
    if str(body.get("response_format") or "mp3") == "wav":
        return Response(wav_bytes(samples, rate), media_type="audio/wav")
    return Response(encode_mp3(samples, rate), media_type="audio/mpeg")


# ─── health ──────────────────────────────────────────────────────────────────


async def _probe(url: str) -> bool:
    try:
        return (await client.get(url, timeout=3.0)).status_code == 200
    except httpx.HTTPError:
        return False


@app.get("/health")
async def health() -> JSONResponse:
    stt = await _probe(f"{ASR_URL.rsplit('/v1', 1)[0]}/health")
    tts = await _probe(f"{TTS_URL}/health")
    return JSONResponse(
        {"ok": stt and tts, "stt": {"model": ASR_MODEL, "ready": stt}, "tts": {"model": TTS_MODEL, "ready": tts}},
        status_code=200 if stt and tts else 503,
    )
