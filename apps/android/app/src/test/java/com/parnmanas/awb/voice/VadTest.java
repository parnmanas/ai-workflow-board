package com.parnmanas.awb.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/** 말(소리)은 한 덩어리로 잘리고, 주변 소음만으로는 열리지 않는다. */
public class VadTest {
  private static short[] tone(int ms, double amp) {
    int n = Vad.SAMPLE_RATE * ms / 1000;
    short[] s = new short[n];
    for (int i = 0; i < n; i++) s[i] = (short) (Math.sin(2 * Math.PI * 300 * i / (double) Vad.SAMPLE_RATE) * amp);
    return s;
  }

  private static short[] noise(int ms, double amp, long seed) {
    java.util.Random r = new java.util.Random(seed);
    int n = Vad.SAMPLE_RATE * ms / 1000;
    short[] s = new short[n];
    for (int i = 0; i < n; i++) s[i] = (short) (r.nextGaussian() * amp);
    return s;
  }

  @Test
  public void oneUtterancePerSpeechBurst() {
    List<byte[]> out = new ArrayList<>();
    Vad vad = new Vad(out::add);
    short[] silence = noise(2000, 30, 1);
    vad.feed(silence, silence.length);
    short[] speech = tone(1200, 6000);
    vad.feed(speech, speech.length);
    short[] tail = noise(1200, 30, 2);
    vad.feed(tail, tail.length);
    assertEquals(1, out.size());
    int ms = out.get(0).length / 2 * 1000 / Vad.SAMPLE_RATE;
    assertTrue("utterance " + ms + "ms", ms >= 1200 && ms <= 2400);
  }

  @Test
  public void steadyBackgroundNoiseDoesNotOpen() {
    List<byte[]> out = new ArrayList<>();
    Vad vad = new Vad(out::add);
    // 시끄러운 방 — 고정 문턱(260)보다 큰 소음이 계속된다. 소음 바닥이 따라 올라가야 한다.
    short[] hum = noise(20_000, 400, 3);
    vad.feed(hum, hum.length);
    assertTrue("opened " + out.size() + " times on steady noise", out.size() <= 1);
  }

  @Test
  public void wavHeaderIsPcm16Mono() {
    byte[] wav = Vad.toWav(new byte[320], 16000);
    assertEquals(44 + 320, wav.length);
    assertEquals('R', wav[0]);
    assertEquals(1, wav[22]); // mono
    assertEquals(16, wav[34]); // bits
  }
}
