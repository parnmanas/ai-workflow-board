package com.parnmanas.awb.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/** 웹 `turnAnswer.logic.ts` · `wake.logic.ts` 와 같은 답을 내는지 — 화면과 앱이 같은 말을 읽어야 한다. */
public class VoiceRulesTest {
  private static JSONObject ev(String turn, String type, String payload) throws Exception {
    return new JSONObject().put("turn_id", turn).put("type", type).put("payload", new JSONObject(payload));
  }

  @Test
  public void lastNonEmptySegmentIsTheAnswer() throws Exception {
    VoiceRules.TurnAnswers t = new VoiceRules.TurnAnswers();
    assertNull(t.push(ev("t1", "text", "{\"text\":\"확인해 볼게요\"}")));
    assertNull(t.push(ev("t1", "tool_call", "{}")));
    assertNull(t.push(ev("t1", "text", "{\"text\":\"배포는 \"}")));
    assertNull(t.push(ev("t1", "text", "{\"text\":\"정상입니다.\"}")));
    assertNull(t.push(ev("t1", "tool_update", "{}")));
    assertNull(t.push(ev("t1", "tool_call", "{}"))); // 답 뒤의 정리용 도구
    VoiceRules.TurnAnswers.Finished f = t.push(ev("t1", "turn", "{\"phase\":\"finished\",\"stop_reason\":\"end_turn\"}"));
    assertEquals("t1", f.turnId);
    assertEquals("배포는 정상입니다.", f.answer);
    assertTrue(f.speakable());
  }

  @Test
  public void cancelledTurnsAreNotSpokenAndOtherTurnsDoNotMix() throws Exception {
    VoiceRules.TurnAnswers t = new VoiceRules.TurnAnswers();
    t.push(ev("a", "text", "{\"text\":\"A\"}"));
    t.push(ev("b", "text", "{\"text\":\"B\"}"));
    assertNull(t.push(ev("a", "turn", "{\"phase\":\"started\"}")));
    VoiceRules.TurnAnswers.Finished a = t.push(ev("a", "turn", "{\"phase\":\"finished\",\"stop_reason\":\"cancelled\"}"));
    assertEquals("A", a.answer);
    assertFalse(a.speakable());
    assertEquals("B", t.push(ev("b", "turn", "{\"phase\":\"finished\"}")).answer);
  }

  @Test
  public void sleepMarkerIsStripped() {
    VoiceRules.SleepSplit s = VoiceRules.splitSleepMarker("좋아요, 쉬세요. [[ Sleep ]]");
    assertTrue(s.sleep);
    assertEquals("좋아요, 쉬세요.", s.text);
    assertFalse(VoiceRules.splitSleepMarker("계속할게요").sleep);
  }

  @Test
  public void fillersAndReportRequests() {
    assertTrue(VoiceRules.isFiller("음..."));
    assertTrue(VoiceRules.isFiller("  "));
    assertFalse(VoiceRules.isFiller("네"));
    assertTrue(VoiceRules.isReportRequest("보고해 줘."));
    assertTrue(VoiceRules.isReportRequest("What happened?"));
    assertFalse(VoiceRules.isReportRequest("보고서 써줘"));
    assertEquals("heyjarvis", VoiceRules.compactKey("Hey, JARVIS!"));
  }

  @Test
  public void wakeNoteGoesFirst() {
    assertTrue(VoiceRules.withWakeNote("안녕").startsWith(VoiceRules.WAKE_PROMPT_NOTE + "\n"));
  }
}
