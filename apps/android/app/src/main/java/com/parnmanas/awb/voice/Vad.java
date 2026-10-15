package com.parnmanas.awb.voice;

/**
 * 에너지 기반 발화 분할 — 서버 STT 앞단. 웹의 Silero VAD 와 같은 자리(말의 시작과 끝을 가른다).
 *
 * 16kHz mono PCM16 을 20ms 프레임으로 본다. 문턱은 고정값이 아니라 **주변 소음에 맞춰 움직인다** —
 * 조용한 방과 TV 가 켜진 거실에서 같은 문턱을 쓰면 하나는 말을 놓치고 하나는 끝없이 서버를 부른다.
 * 말이 아닌 소리가 걸러지지 않아도 서버가 `no_speech` 로 버린다(비용은 왕복 한 번).
 */
public final class Vad {
  public interface Listener {
    void onUtterance(byte[] pcm16Mono16k);
  }

  public static final int SAMPLE_RATE = 16000;
  private static final int FRAME_SAMPLES = 320; // 20ms
  private static final int START_FRAMES = 4; // 80ms 이어지면 말의 시작
  private static final int END_SILENCE_FRAMES = 40; // 800ms 조용하면 끝
  private static final int MIN_FRAMES = 15; // 300ms 미만은 파열음
  private static final int MAX_FRAMES = 500; // 10s — 길면 잘라서 보낸다
  private static final int PREROLL_FRAMES = 12; // 앞 240ms 를 살린다(첫 음절 손실 방지)
  private static final double MIN_THRESHOLD = 260.0;
  private static final double NOISE_RATIO = 3.0;
  private static final double NOISE_ALPHA = 0.02; // 소음 바닥의 느린 추적

  private final Listener listener;
  private final short[] pending = new short[FRAME_SAMPLES];
  private int pendingCount = 0;
  private final short[][] preroll = new short[PREROLL_FRAMES][];
  private int prerollCount = 0;
  private short[] open = null;
  private int openLen = 0;
  private int speechFrames = 0;
  private int silenceFrames = 0;
  private double noiseFloor = 120.0;

  public Vad(Listener listener) {
    this.listener = listener;
  }

  /** 지금까지 들은 것을 버린다(소리를 내는 동안 들은 것 · 일시정지 뒤). 소음 바닥은 남긴다. */
  public void reset() {
    pendingCount = 0;
    prerollCount = 0;
    open = null;
    openLen = 0;
    speechFrames = 0;
    silenceFrames = 0;
  }

  public void feed(short[] samples, int count) {
    int off = 0;
    while (off < count) {
      int n = Math.min(FRAME_SAMPLES - pendingCount, count - off);
      System.arraycopy(samples, off, pending, pendingCount, n);
      pendingCount += n;
      off += n;
      if (pendingCount == FRAME_SAMPLES) {
        pendingCount = 0;
        onFrame(pending.clone());
      }
    }
  }

  private static double rms(short[] frame) {
    long sum = 0;
    for (short s : frame) sum += (long) s * s;
    return Math.sqrt(sum / (double) frame.length);
  }

  private double threshold() {
    return Math.max(MIN_THRESHOLD, noiseFloor * NOISE_RATIO);
  }

  private void onFrame(short[] frame) {
    double level = rms(frame);
    boolean speech = level >= threshold();
    if (open == null) {
      if (speech) {
        speechFrames++;
        pushPreroll(frame);
        if (speechFrames >= START_FRAMES) {
          open = new short[FRAME_SAMPLES * (PREROLL_FRAMES + MAX_FRAMES)];
          openLen = 0;
          for (int i = 0; i < prerollCount; i++) append(preroll[i]);
          prerollCount = 0;
          silenceFrames = 0;
        }
      } else {
        speechFrames = 0;
        noiseFloor += (level - noiseFloor) * NOISE_ALPHA;
        pushPreroll(frame);
      }
      return;
    }
    append(frame);
    silenceFrames = speech ? 0 : silenceFrames + 1;
    int frames = openLen / FRAME_SAMPLES;
    if ((silenceFrames >= END_SILENCE_FRAMES && frames >= MIN_FRAMES) || frames >= PREROLL_FRAMES + MAX_FRAMES) {
      emit();
    }
  }

  private void append(short[] frame) {
    if (openLen + frame.length > open.length) return;
    System.arraycopy(frame, 0, open, openLen, frame.length);
    openLen += frame.length;
  }

  private void pushPreroll(short[] frame) {
    if (prerollCount < PREROLL_FRAMES) {
      preroll[prerollCount++] = frame;
    } else {
      System.arraycopy(preroll, 1, preroll, 0, PREROLL_FRAMES - 1);
      preroll[PREROLL_FRAMES - 1] = frame;
    }
  }

  private void emit() {
    short[] done = open;
    int len = openLen;
    reset();
    byte[] pcm = new byte[len * 2];
    for (int i = 0; i < len; i++) {
      pcm[i * 2] = (byte) (done[i] & 0xff);
      pcm[i * 2 + 1] = (byte) ((done[i] >> 8) & 0xff);
    }
    listener.onUtterance(pcm);
  }

  /** PCM16 mono → WAV (서버 transcribe 가 받는 형식 중 하나). */
  public static byte[] toWav(byte[] pcm16, int sampleRate) {
    int dataLen = pcm16.length;
    byte[] wav = new byte[44 + dataLen];
    putAscii(wav, 0, "RIFF");
    putInt(wav, 4, 36 + dataLen);
    putAscii(wav, 8, "WAVE");
    putAscii(wav, 12, "fmt ");
    putInt(wav, 16, 16);
    putShort(wav, 20, 1); // PCM
    putShort(wav, 22, 1); // mono
    putInt(wav, 24, sampleRate);
    putInt(wav, 28, sampleRate * 2);
    putShort(wav, 32, 2);
    putShort(wav, 34, 16);
    putAscii(wav, 36, "data");
    putInt(wav, 40, dataLen);
    System.arraycopy(pcm16, 0, wav, 44, dataLen);
    return wav;
  }

  private static void putAscii(byte[] b, int off, String s) {
    for (int i = 0; i < s.length(); i++) b[off + i] = (byte) s.charAt(i);
  }

  private static void putInt(byte[] b, int off, int v) {
    b[off] = (byte) (v & 0xff);
    b[off + 1] = (byte) ((v >> 8) & 0xff);
    b[off + 2] = (byte) ((v >> 16) & 0xff);
    b[off + 3] = (byte) ((v >> 24) & 0xff);
  }

  private static void putShort(byte[] b, int off, int v) {
    b[off] = (byte) (v & 0xff);
    b[off + 1] = (byte) ((v >> 8) & 0xff);
  }
}
