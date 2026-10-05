"""Run with the isolated voice-tools environment: python -m unittest test_voice_server -v."""
import io
import unittest
from unittest.mock import patch

import httpx
import numpy as np
import soundfile as sf

import speaker_filter as speaker
import awb_voice_server as gateway


class SpeakerTests(unittest.TestCase):
    def test_foreign_windows_cannot_ride_along_with_matching_speech(self):
        chunks = [np.ones(16000), np.full(16000, 2), np.full(16000, 3)]
        vectors = [np.array([1, 0]), np.array([0, 1]), np.array([0.9, 0.1])]
        selected, score = speaker.select_windows(chunks, vectors, np.array([[1, 0]]), 0.6)
        self.assertEqual([float(chunk[0]) for chunk in selected], [1, 3])
        self.assertAlmostEqual(score, 1.0)

    def test_noise_has_no_speech_regions(self):
        self.assertEqual(speaker.speech_regions(np.zeros(32000, dtype=np.float32)), [])
        noise = np.random.default_rng(10).normal(0, 0.008, 32000).astype(np.float32)
        self.assertEqual(speaker.speech_regions(noise), [])

    def test_short_and_inconsistent_samples_are_rejected(self):
        short = np.zeros(16000, dtype=np.float32)
        with patch.object(speaker, 'speech_regions', return_value=[{'start': 0, 'end': 16000}]):
            with self.assertRaisesRegex(ValueError, 'at least 6 seconds'):
                speaker.enroll(short)
        audio = np.zeros(96000, dtype=np.float32)
        with patch.object(speaker, 'speech_regions', return_value=[{'start': 0, 'end': len(audio)}]), \
                patch.object(speaker, 'embedding', side_effect=[np.array([1., 0]), np.array([-1., 0]), np.array([0., 1])]):
            with self.assertRaisesRegex(ValueError, 'inconsistent voices'):
                speaker.enroll(audio)

    def test_model_change_and_invalid_vectors_fail_closed(self):
        engine = type('FakeEngine', (), {'dim': 2})()
        with patch.object(speaker, 'extractor', return_value=engine), patch.object(speaker, 'model_id', return_value='new'):
            with self.assertRaisesRegex(ValueError, 'model changed'):
                speaker.filter_speaker(np.zeros(16000), {'model': 'old', 'embeddings': [[1, 0]]}, 0.6)
            with self.assertRaisesRegex(ValueError, 'Invalid speaker profile'):
                speaker.filter_speaker(np.zeros(16000), {'model': 'new', 'embeddings': [[float('nan'), 0]]}, 0.6)


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=gateway.app), base_url='http://test',
            headers={'Authorization': 'Bearer ' + gateway.API_KEY})
        buf = io.BytesIO()
        sf.write(buf, np.zeros(16000), 16000, format='WAV')
        self.files = {'file': ('sample.wav', buf.getvalue(), 'audio/wav')}

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_unknown_models_are_rejected_and_whisper_is_explicit(self):
        with patch.object(gateway, 'WHISPER_MODEL', 'large-v3-turbo'), patch.object(gateway, 'whisper_transcribe', return_value='hello'):
            res = await self.client.post('/v1/audio/transcriptions', files=self.files, data={'model': 'whisper-large-v3-turbo'})
            self.assertEqual(res.json()['text'], 'hello')
            res = await self.client.post('/v1/audio/transcriptions', files=self.files, data={'model': 'unknown'})
            self.assertEqual(res.status_code, 400)

    async def test_non_speakers_return_no_audio(self):
        with patch.object(speaker, 'filter_speaker', return_value=(np.zeros(0), 0.2, 'speaker_mismatch')):
            res = await self.client.post('/v1/audio/speaker/filter', files=self.files, data={'profile': '{}'})
            self.assertEqual(res.status_code, 204)
            self.assertEqual(res.content, b'')
            self.assertEqual(res.headers['x-speaker-ignored'], 'speaker_mismatch')
        with patch.object(speaker, 'filter_speaker', return_value=(np.ones(1000), 0.8, None)):
            res = await self.client.post('/v1/audio/speaker/filter', files=self.files, data={'profile': '{}'})
            self.assertEqual(res.headers['x-speaker-accepted'], 'true')
            self.assertEqual(res.content[:4], b'RIFF')

    async def test_bad_sample_and_profile_errors_are_explicit(self):
        with patch.object(speaker, 'enroll', side_effect=ValueError('at least 6 seconds')):
            res = await self.client.post('/v1/audio/speaker/embedding', files=self.files)
            self.assertEqual(res.status_code, 409)
            self.assertIn('at least 6 seconds', res.json()['detail'])
        res = await self.client.post('/v1/audio/speaker/filter', files=self.files, data={'profile': '[]'})
        self.assertEqual(res.status_code, 409)
        res = await self.client.post('/v1/audio/speaker/filter', files=self.files, data={'profile': '{}', 'threshold': '1.2'})
        self.assertEqual(res.status_code, 400)


if __name__ == '__main__':
    unittest.main()
