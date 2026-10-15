package com.parnmanas.awb.voice;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * 웹 음성 규칙의 네이티브 사본 — 원본은 `apps/client/src/voice/wake.logic.ts` 와 `turnAnswer.logic.ts`.
 * 깨우는 말 판정 자체는 서버(`POST /api/voice/operators/match`)가 하므로 여기에는 대화 중의 작은
 * 규칙만 둔다. 웹을 바꾸면 여기도 같이 바꿀 것(`apps/client/test/android-voice-rules.test.mjs` 가 본다).
 */
public final class VoiceRules {
  private VoiceRules() {}

  public static final String SLEEP_MARKER = "[[sleep]]";
  private static final Pattern SLEEP_MARKER_RE = Pattern.compile("\\[\\[\\s*sleep\\s*\\]\\]", Pattern.CASE_INSENSITIVE);

  /** 깨어난 뒤 처음 보내는 요청 앞에 붙는 한 줄 — 웹 `WAKE_PROMPT_NOTE` 와 글자 그대로 같아야 한다. */
  public static final String WAKE_PROMPT_NOTE =
      "(음성 대화 — 부르기만 하면 듣고 있다고 짧게 답하고 다음 말을 기다리세요. 이어진 요청이 있으면 그 요청에 답하세요. 호출에 대한 응답에는 잠들기 표시를 붙이지 마세요. 사용자가 대화를 마치는 말을 하면 짧게 인사하고 답 맨 끝에 " + SLEEP_MARKER + " 를 붙이세요.)";

  /** 깨어 있다가 아무 말이 없으면 이만큼 뒤에 잠든다(답을 기다리거나 읽는 동안은 세지 않는다). */
  public static final long WAKE_IDLE_SLEEP_MS = 60_000;
  /** 알림음 뒤에 이름 없이 듣는 창. */
  public static final long NOTIFICATION_FOLLOW_UP_MS = 15_000;
  /** 알림 뒤 "보고해" 만으로 그 operator 를 부를 수 있는 시간. */
  public static final long REPORT_TARGET_MS = 10 * 60_000;

  // Android(ICU) 정규식은 \s · \p{P} 가 원래 유니코드다 — UNICODE_CHARACTER_CLASS 플래그를 주면 던진다.
  private static final Pattern SEPARATOR_RE = Pattern.compile("[\\s\\p{P}\\p{S}\\u3000]");
  private static final Set<String> FILLERS = new HashSet<>(Arrays.asList(
      "음", "음음", "으음", "어", "어어", "흠", "으", "아", "um", "uh", "hmm", "mm", "eh"));
  private static final Pattern REPORT_REQUEST_RE = Pattern.compile(
      "^(보고해(?:줘|주세요|줄래)?|보고(?:해|해줘|해주세요|해줄래|부탁해)|알림(?:내용)?(?:알려줘|설명해줘)|무슨(?:일이야|일있어|작업이끝났어)|report(?:please)?|givemeareport|whathappened)$",
      Pattern.CASE_INSENSITIVE);

  /** 이름 비교 키 — 글자·숫자만 남긴 소문자(웹 `compactKey`). */
  public static String compactKey(String value) {
    String norm = Normalizer.normalize(value == null ? "" : value, Normalizer.Form.NFC);
    return SEPARATOR_RE.matcher(norm).replaceAll("").toLowerCase();
  }

  public static boolean isFiller(String text) {
    String key = compactKey(text);
    return key.isEmpty() || FILLERS.contains(key);
  }

  public static boolean isReportRequest(String text) {
    return REPORT_REQUEST_RE.matcher(compactKey(text)).matches();
  }

  public static final class SleepSplit {
    public final String text;
    public final boolean sleep;

    SleepSplit(String text, boolean sleep) {
      this.text = text;
      this.sleep = sleep;
    }
  }

  public static SleepSplit splitSleepMarker(String answer) {
    String a = answer == null ? "" : answer;
    if (!SLEEP_MARKER_RE.matcher(a).find()) return new SleepSplit(a, false);
    return new SleepSplit(SLEEP_MARKER_RE.matcher(a).replaceAll("").trim(), true);
  }

  public static String withWakeNote(String text) {
    return WAKE_PROMPT_NOTE + "\n" + text;
  }

  /**
   * 한 턴의 "읽어 줄 답" — 도구 · 권한 요청 · 질문 · plan 이 덩어리를 끊고, 마지막으로 비어 있지 않은
   * 덩어리가 답이다(웹 `TurnAnswerTracker`). `tool_update` 는 끊지 않는다.
   */
  public static final class TurnAnswers {
    private static final Set<String> BREAKS = new HashSet<>(Arrays.asList(
        "tool_call", "permission_request", "elicitation_request", "plan"));
    private final Map<String, List<StringBuilder>> turns = new HashMap<>();

    public static final class Finished {
      public final String turnId;
      public final String stopReason;
      public final String answer;

      Finished(String turnId, String stopReason, String answer) {
        this.turnId = turnId;
        this.stopReason = stopReason;
        this.answer = answer;
      }

      /** 사용자가 멈춘 턴은 읽지 않는다. */
      public boolean speakable() {
        return !answer.isEmpty() && !"cancelled".equals(stopReason);
      }
    }

    /** `agent_session_event` 의 `event` 하나. 턴이 끝났으면 그 답을 돌려준다. */
    public Finished push(JSONObject ev) {
      if (ev == null) return null;
      String turnId = ev.optString("turn_id", "");
      if (turnId.isEmpty()) return null;
      String type = ev.optString("type", "");
      JSONObject payload = ev.optJSONObject("payload");
      if ("turn".equals(type)) {
        if (payload == null || !"finished".equals(payload.optString("phase", ""))) return null;
        List<StringBuilder> segments = turns.remove(turnId);
        String stop = payload.optString("stop_reason", "");
        return new Finished(turnId, stop.isEmpty() ? "end_turn" : stop, lastNonEmpty(segments));
      }
      if (!"text".equals(type) && !BREAKS.contains(type)) return null;
      List<StringBuilder> segments = turns.get(turnId);
      if (segments == null) {
        segments = new ArrayList<>();
        segments.add(new StringBuilder());
        turns.put(turnId, segments);
      }
      if ("text".equals(type)) {
        segments.get(segments.size() - 1).append(payload == null ? "" : payload.optString("text", ""));
      } else {
        segments.add(new StringBuilder());
      }
      return null;
    }

    public void forget(String turnId) {
      turns.remove(turnId);
    }

    private static String lastNonEmpty(List<StringBuilder> segments) {
      if (segments == null) return "";
      for (int i = segments.size() - 1; i >= 0; i--) {
        String t = segments.get(i).toString().trim();
        if (!t.isEmpty()) return t;
      }
      return "";
    }
  }
}
