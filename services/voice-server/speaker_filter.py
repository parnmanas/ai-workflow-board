"""VAD + speaker embeddings; no recordings or user profiles are stored on the GPU host."""
from __future__ import annotations

import hashlib
import os
import threading
from functools import lru_cache

import numpy as np

RATE = 16000
MODEL_PATH = os.environ.get('SPEAKER_MODEL_PATH', '')
MODEL_LOCK = threading.RLock()


@lru_cache(maxsize=1)
def extractor():
    import sherpa_onnx
    if not MODEL_PATH or not os.path.isfile(MODEL_PATH):
        raise ValueError('Speaker model is not installed on the voice server.')
    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=MODEL_PATH, num_threads=2, provider='cpu')
    if not config.validate():
        raise ValueError('Invalid speaker model configuration.')
    return sherpa_onnx.SpeakerEmbeddingExtractor(config)


@lru_cache(maxsize=1)
def model_id() -> str:
    # Filename alone cannot distinguish a replacement model with the same vector dimensions.
    with open(MODEL_PATH, 'rb') as file:
        digest = hashlib.file_digest(file, 'sha256').hexdigest()
    return f'sherpa-onnx:{digest}'


def speech_regions(audio: np.ndarray) -> list[dict]:
    from faster_whisper.vad import get_speech_timestamps, VadOptions
    return get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=250, speech_pad_ms=80))


def unit(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(vector).all() or norm < 1e-8:
        raise ValueError('Invalid speaker embedding.')
    return vector / norm


def embedding(audio: np.ndarray) -> np.ndarray:
    engine = extractor()
    stream = engine.create_stream()
    stream.accept_waveform(sample_rate=RATE, waveform=np.ascontiguousarray(audio, dtype=np.float32))
    stream.input_finished()
    if not engine.is_ready(stream):
        raise ValueError('Not enough speech to identify a speaker.')
    return unit(np.asarray(engine.compute(stream), dtype=np.float32))


def windows(audio: np.ndarray, regions: list[dict]) -> list[np.ndarray]:
    result = []
    for region in regions:
        speech = audio[region['start']:region['end']]
        # Evaluate each window, not the entire recording: a second speaker must not ride along.
        for chunk in np.array_split(speech, max(1, int(np.ceil(len(speech) / (RATE * 2))))):
            if len(chunk) >= RATE * 0.5:
                result.append(chunk)
    return result


def enroll(audio: np.ndarray) -> dict:
    with MODEL_LOCK:
        chunks = windows(audio, speech_regions(audio))
        voiced = sum(len(chunk) for chunk in chunks) / RATE
        if voiced < 6:
            raise ValueError('Read the sample for at least 6 seconds of speech in a quiet room, then try again.')
        if float(np.mean(np.abs(audio) >= 0.99)) > 0.05:
            raise ValueError('The recording is clipping. Move away from the microphone and record again.')
        vectors = np.stack([embedding(chunk) for chunk in chunks])
        center = unit(vectors.mean(axis=0))
        if float(np.min(vectors @ center)) < 0.45 or float(np.min(vectors @ vectors.T)) < 0.35:
            raise ValueError('The sample contains inconsistent voices. Record only your own voice again.')
        return {'embedding': center.tolist(), 'model': model_id(), 'speech_seconds': round(voiced, 2)}


def select_windows(chunks: list[np.ndarray], vectors: list[np.ndarray], references: np.ndarray, threshold: float) -> tuple[list[np.ndarray], float]:
    scores = [float(np.max(references @ unit(vector))) for vector in vectors]
    return [chunk for chunk, score in zip(chunks, scores) if score >= threshold], max(scores, default=0.0)


def filter_speaker(audio: np.ndarray, profile: dict, threshold: float) -> tuple[np.ndarray, float, str | None]:
    with MODEL_LOCK:
        extractor()  # fail closed when enabled but unavailable
        if profile.get('model') != model_id():
            raise ValueError('The speaker model changed. Re-enroll your voice in Voice.')
        try:
            references = np.asarray(profile['embeddings'], dtype=np.float32)
            if references.ndim != 2 or not 1 <= len(references) <= 5 or references.shape[1] != extractor().dim:
                raise ValueError('Invalid profile dimensions.')
            references = np.stack([unit(vector) for vector in references])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError('Invalid speaker profile. Re-enroll your voice in Voice.') from exc
        regions = speech_regions(audio)
        if not regions:
            return np.array([], dtype=np.float32), 0.0, 'no_speech'
        chunks = windows(audio, regions)
        if not chunks:
            return np.array([], dtype=np.float32), 0.0, 'insufficient_speech'
        selected, score = select_windows(chunks, [embedding(chunk) for chunk in chunks], references, threshold)
        if not selected:
            return np.array([], dtype=np.float32), score, 'speaker_mismatch'
        # Preserve a small boundary between kept utterances for ASR, rather than merging syllables.
        silence = np.zeros(int(RATE * 0.08), dtype=np.float32)
        return np.concatenate([part for chunk in selected for part in (chunk, silence)]), score, None
