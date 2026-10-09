package com.parnmanas.awb;

import java.util.ArrayList;

/**
 * 에너지 기반 발화 분할 — 서버 STT 앞단. 무거운 VAD 모델 없이도 "말의 시작과 끝"을
 * 가른다 (웹의 Silero VAD와 같은 역할, 정확도는 낮고 배터리는 가볍다).
 *
 * 16kHz mono PCM16을 20ms 프레임으로 보고, 일정 시간 소리가 이어지면 열고,
 * 800ms 조용하면 닫는다. 짧은 파열음(<300ms)은 버린다. 호출 스레드 그대로
 * 콜백하므로 네트워크는 호출 쪽(AwbWakeService의 업로드 executor)에서 떼어 낸다.
 */
public class AwbVad {
  public interface Listener {
    void onUtterance(byte[] pcm16Mono16k);
  }

  public static final int SAMPLE_RATE = 16000;
  private static final int FRAME_SAMPLES = 320; // 20ms
  private static final int START_FRAMES = 4; // 80ms 이어지면 열기
  private static final int END_SILENCE_FRAMES = 40; // 800ms 조용하면 닫기
  private static final int MIN_FRAMES = 15; // 300ms 미만은 파열음으로 버림
  private static final int MAX_FRAMES = 400; // 8s 상한 — 길면 잘라서 보냄
  private static final int PREROLL_FRAMES = 10; // 앞 200ms 살림 (개시음 손실 방지)
  private static final double SPEECH_RMS = 280.0;

  private final Listener listener;
  private final short[] pending = new short[FRAME_SAMPLES];
  private int pendingCount = 0;
  private final short[][] preroll = new short[PREROLL_FRAMES][];
  private int prerollCount = 0;
  private ArrayList<Short> open = null;
  private int speechFrames = 0;
  private int silenceFrames = 0;

  public AwbVad(Listener listener) {
    this.listener = listener;
  }

  public void reset() {
    pendingCount = 0;
    prerollCount = 0;
    open = null;
    speechFrames = 0;
    silenceFrames = 0;
  }

  public void feed(short[] samples, int count) {
    int off = 0;
    while (off < count) {
      int room = FRAME_SAMPLES - pendingCount;
      int n = Math.min(room, count - off);
      System.arraycopy(samples, off, pending, pendingCount, n);
      pendingCount += n;
      off += n;
      if (pendingCount == FRAME_SAMPLES) {
        short[] frame = pending.clone();
        pendingCount = 0;
        onFrame(frame);
      }
    }
  }

  private static double rms(short[] frame) {
    long sum = 0;
    for (short s : frame) sum += (long) s * s;
    return Math.sqrt(sum / (double) frame.length);
  }

  private void onFrame(short[] frame) {
    boolean speech = rms(frame) >= SPEECH_RMS;
    if (open == null) {
      if (speech) {
        speechFrames++;
        pushPreroll(frame);
        if (speechFrames >= START_FRAMES) {
          open = new ArrayList<>(FRAME_SAMPLES * (PREROLL_FRAMES + MAX_FRAMES));
          for (int i = 0; i < prerollCount; i++) {
            for (short s : preroll[i]) open.add(s);
          }
          prerollCount = 0;
          silenceFrames = 0;
        }
      } else {
        speechFrames = 0;
        pushPreroll(frame);
      }
      return;
    }
    for (short s : frame) open.add(s);
    if (speech) {
      silenceFrames = 0;
    } else {
      silenceFrames++;
    }
    int frames = open.size() / FRAME_SAMPLES;
    if ((silenceFrames >= END_SILENCE_FRAMES && frames >= MIN_FRAMES) || frames >= MAX_FRAMES) {
      emit();
    }
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
    ArrayList<Short> done = open;
    open = null;
    speechFrames = 0;
    silenceFrames = 0;
    prerollCount = 0;
    byte[] pcm = new byte[done.size() * 2];
    for (int i = 0; i < done.size(); i++) {
      short s = done.get(i);
      pcm[i * 2] = (byte) (s & 0xff);
      pcm[i * 2 + 1] = (byte) ((s >> 8) & 0xff);
    }
    listener.onUtterance(pcm);
  }
}
