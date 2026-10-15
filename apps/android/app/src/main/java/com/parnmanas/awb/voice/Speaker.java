package com.parnmanas.awb.voice;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.media.MediaPlayer;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 소리 내기 — 답 낭독 · 알림음 · 신호음. 부르는 쪽 스레드를 막고 끝까지 재생한다(서비스의 대화
 * 스레드가 순서대로 부른다). 재생하는 동안은 오디오 포커스를 잠깐 잡아 음악을 줄인다.
 */
final class Speaker {
  private final Context ctx;
  private final AudioManager audio;
  private final AudioAttributes attrs = new AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ASSISTANT)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build();
  private volatile MediaPlayer current;
  private volatile boolean cancelled = false;

  Speaker(Context ctx) {
    this.ctx = ctx.getApplicationContext();
    this.audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
  }

  /** 지금 소리와 이어질 소리를 멈춘다. */
  void cancel() {
    cancelled = true;
    MediaPlayer p = current;
    if (p != null) {
      try {
        p.stop();
      } catch (Exception ignored) {
      }
    }
  }

  void resetCancel() {
    cancelled = false;
  }

  boolean isCancelled() {
    return cancelled;
  }

  /** 서버가 만든 소리(mp3 · wav 등)를 끝까지 재생한다. */
  boolean play(byte[] bytes, String contentType) {
    if (cancelled || bytes == null || bytes.length == 0) return false;
    File f = null;
    AudioFocusRequest focus = requestFocus();
    try {
      f = File.createTempFile("awb-voice", suffix(contentType), ctx.getCacheDir());
      try (FileOutputStream out = new FileOutputStream(f)) {
        out.write(bytes);
      }
      return playFile(f.getAbsolutePath(), -1);
    } catch (Exception e) {
      return false;
    } finally {
      if (f != null) f.delete();
      abandonFocus(focus);
    }
  }

  /** 앱에 든 알림음(res/raw). */
  boolean playRaw(int resId) {
    if (cancelled) return false;
    AudioFocusRequest focus = requestFocus();
    try {
      return playFile(null, resId);
    } finally {
      abandonFocus(focus);
    }
  }

  private boolean playFile(String path, int resId) {
    CountDownLatch done = new CountDownLatch(1);
    MediaPlayer p = new MediaPlayer();
    try {
      p.setAudioAttributes(attrs);
      if (path != null) {
        p.setDataSource(path);
      } else {
        android.content.res.AssetFileDescriptor afd = ctx.getResources().openRawResourceFd(resId);
        p.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
        afd.close();
      }
      p.setOnCompletionListener(mp -> done.countDown());
      p.setOnErrorListener((mp, what, extra) -> {
        done.countDown();
        return true;
      });
      p.prepare();
      current = p;
      if (cancelled) return false;
      p.start();
      long limit = Math.max(5_000, p.getDuration() + 5_000L);
      done.await(limit, TimeUnit.MILLISECONDS);
      return !cancelled;
    } catch (Exception e) {
      return false;
    } finally {
      current = null;
      try {
        p.release();
      } catch (Exception ignored) {
      }
    }
  }

  /** 깨어났다(올라가는 두 음) · 잠든다(내려가는 두 음) — 웹 `earcon.ts` 와 같은 소리. */
  void earcon(boolean wake) {
    int[] tones = wake ? new int[] { 660, 880 } : new int[] { 784, 523 };
    int rate = 24000;
    int noteSamples = (int) (rate * 0.13);
    short[] pcm = new short[noteSamples * tones.length];
    for (int n = 0; n < tones.length; n++) {
      for (int i = 0; i < noteSamples; i++) {
        double t = i / (double) rate;
        // 15ms 에 올라가 120ms 까지 지수로 줄어드는 봉우리(웹과 같은 모양).
        double env = t < 0.015 ? t / 0.015 : Math.exp(-(t - 0.015) * 40);
        if (t > 0.12) env = 0;
        pcm[n * noteSamples + i] = (short) (Math.sin(2 * Math.PI * tones[n] * t) * env * 0.3 * Short.MAX_VALUE);
      }
    }
    AudioTrack track = null;
    try {
      track = new AudioTrack.Builder()
          .setAudioAttributes(attrs)
          .setAudioFormat(new AudioFormat.Builder()
              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
              .setSampleRate(rate)
              .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
              .build())
          .setTransferMode(AudioTrack.MODE_STATIC)
          .setBufferSizeInBytes(pcm.length * 2)
          .build();
      track.write(pcm, 0, pcm.length);
      track.play();
      Thread.sleep(pcm.length * 1000L / rate + 60);
    } catch (Exception ignored) {
      // 소리 장치가 없으면 신호음은 건너뛴다.
    } finally {
      if (track != null) {
        try {
          track.release();
        } catch (Exception ignored) {
        }
      }
    }
  }

  private AudioFocusRequest requestFocus() {
    if (audio == null) return null;
    AudioFocusRequest req = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(attrs)
        .build();
    audio.requestAudioFocus(req);
    return req;
  }

  private void abandonFocus(AudioFocusRequest req) {
    if (audio != null && req != null) audio.abandonAudioFocusRequest(req);
  }

  private static String suffix(String contentType) {
    String ct = contentType == null ? "" : contentType.toLowerCase();
    if (ct.contains("wav")) return ".wav";
    if (ct.contains("ogg") || ct.contains("opus")) return ".ogg";
    if (ct.contains("aac") || ct.contains("mp4")) return ".m4a";
    return ".mp3";
  }
}
