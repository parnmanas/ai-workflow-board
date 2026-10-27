package com.parnmanas.awb.voice;

import android.content.Context;
import android.net.Uri;
import com.parnmanas.awb.Auth;
import com.parnmanas.awb.Http;
import com.parnmanas.awb.Server;
import com.parnmanas.awb.Servers;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 상시 음성 서비스가 쓰는 서버 API — 웹 화면이 쓰는 것과 같은 엔드포인트다(새 경로를 만들지 않는다).
 * 401 이면 단말 자격으로 세션을 다시 받아 한 번 더 시도한다. 서버 하나에 묶인다 — 다른 서버로 옮겨 가면
 * 서비스가 새로 만든다.
 */
final class VoiceApi {
  static final class Unauthorized extends IOException {
    Unauthorized() {
      super("로그인이 필요합니다");
    }
  }

  static final class Busy extends IOException {
    Busy() {
      super("session_busy");
    }
  }

  static final class Operator {
    String id = "";
    String name = "";
    String managerId = "";
    String cli = "";
    String sessionId = "";
    String accountId = "";

    static Operator from(JSONObject j) {
      Operator op = new Operator();
      op.id = j.optString("id", "");
      op.name = j.optString("name", "");
      op.managerId = j.optString("manager_id", "");
      op.cli = j.optString("cli", "");
      op.sessionId = j.optString("session_id", "");
      op.accountId = j.optString("account_id", "");
      return op;
    }

    boolean sameSession(String m, String c, String s) {
      return managerId.equals(m) && cli.equals(c) && sessionId.equals(s);
    }

    /** 알림을 누르면 이 세션으로 — 그사이 다른 서버로 옮겨 갔어도 이 서버로 돌아온다. */
    String deepLink(String serverId) {
      return "awb://sessions/" + Uri.encode(managerId) + "/" + Uri.encode(cli) + "/" + Uri.encode(sessionId)
          + "?server=" + Uri.encode(serverId);
    }
  }

  static final class Config {
    boolean wakeReady;
    String wakeError = "";
    boolean sttReady;
    boolean ttsReady;
    boolean ttsStreaming;
  }

  static final class Match {
    Operator operator;
    String rest = "";
  }

  static final class Audio {
    final byte[] bytes;
    final String contentType;

    Audio(byte[] bytes, String contentType) {
      this.bytes = bytes;
      this.contentType = contentType;
    }
  }

  private final Context ctx;
  private final String serverId;

  VoiceApi(Context ctx, String serverId) {
    this.ctx = ctx.getApplicationContext();
    this.serverId = serverId;
  }

  private interface Call {
    Http.Response run(String base, Map<String, String> headers) throws IOException;
  }

  private Http.Response call(String accountId, Call call) throws IOException {
    Server server = Servers.get(ctx, serverId);
    if (server == null) throw new Unauthorized();
    String base = server.url;
    String token = Auth.token(ctx, serverId);
    if (token.isEmpty()) throw new Unauthorized();
    Map<String, String> h = Auth.headers(token);
    if (accountId != null && !accountId.isEmpty()) h.put("X-Account-Id", accountId);
    Http.Response r = call.run(base, h);
    if (r.code != 401) return r;
    token = Auth.refresh(ctx, serverId, token);
    if (token.isEmpty()) throw new Unauthorized();
    h.put("Authorization", "Bearer " + token);
    r = call.run(base, h);
    if (r.code == 401) throw new Unauthorized();
    return r;
  }

  private static Http.Response ok(Http.Response r) throws IOException {
    if (!r.ok()) throw new IOException(r.errorText());
    return r;
  }

  Config config() throws IOException {
    JSONObject j = ok(call(null, (b, h) -> Http.getJson(b + "/api/voice/config", h))).json();
    Config c = new Config();
    JSONObject wake = j.optJSONObject("wake");
    JSONObject stt = j.optJSONObject("stt");
    JSONObject tts = j.optJSONObject("tts");
    c.wakeReady = wake != null && wake.optBoolean("ready", false);
    c.wakeError = wake == null ? "" : wake.optString("error", "");
    c.sttReady = stt != null && stt.optBoolean("ready", false);
    c.ttsReady = tts != null && tts.optBoolean("ready", false);
    c.ttsStreaming = tts != null && tts.optBoolean("streaming", false);
    return c;
  }

  List<Operator> operators() throws IOException {
    JSONObject j = ok(call(null, (b, h) -> Http.getJson(b + "/api/voice/operators", h))).json();
    JSONArray arr = j.optJSONArray("operators");
    List<Operator> out = new ArrayList<>();
    if (arr == null) return out;
    for (int i = 0; i < arr.length(); i++) {
      JSONObject o = arr.optJSONObject(i);
      if (o != null) out.add(Operator.from(o));
    }
    return out;
  }

  /** 발화 → 글자. 말이 아니었으면(서버가 버렸으면) "". `wake` 는 잠든 동안(자체 호스팅 엔진). */
  String transcribe(byte[] wav, boolean wake) throws IOException {
    String path = "/api/voice/transcribe" + (wake ? "?purpose=wake" : "");
    Http.Response r = ok(call(null, (b, h) ->
        Http.request("POST", b + path, h, wav, "audio/wav", Http.READ_TIMEOUT_MS)));
    JSONObject j = r.json();
    if (!j.optString("ignored", "").isEmpty()) return "";
    return j.optString("text", "").trim();
  }

  Match match(String text) throws IOException {
    JSONObject j = ok(call(null, (b, h) ->
        Http.postJson(b + "/api/voice/operators/match", h, Http.obj("text", text)))).json();
    Match m = new Match();
    JSONObject op = j.optJSONObject("operator");
    if (op != null) {
      m.operator = Operator.from(op);
      m.rest = j.optString("rest", "").trim();
    }
    return m;
  }

  /** operator 세션에 말을 보낸다. 돌려받은 turn_id 로 답을 기다린다. 바쁘면 Busy. */
  String prompt(Operator op, String text) throws IOException {
    String path = "/api/agent-sessions/hosts/" + Uri.encode(op.managerId) + "/" + Uri.encode(op.cli)
        + "/sessions/" + Uri.encode(op.sessionId) + "/prompt";
    Http.Response r = call(op.accountId, (b, h) -> Http.postJson(b + path, h, Http.obj("text", text)));
    if (r.code == 409 && r.text().contains("session_busy")) throw new Busy();
    return ok(r).json().optString("turn_id", "");
  }

  List<String> speakable(String text, boolean summary) throws IOException {
    return speakable(text, summary, false);
  }

  List<String> speakable(String text, boolean summary, boolean partial) throws IOException {
    JSONObject j = ok(call(null, (b, h) ->
        Http.postJson(b + "/api/voice/speakable", h, Http.obj("text", text, "summary", summary, "partial", partial)))).json();
    JSONArray arr = j.optJSONArray("chunks");
    List<String> out = new ArrayList<>();
    if (arr == null) return out;
    for (int i = 0; i < arr.length(); i++) {
      String c = arr.optString(i, "").trim();
      if (!c.isEmpty()) out.add(c);
    }
    return out;
  }

  Audio speech(String chunk) throws IOException {
    Http.Response r = ok(call(null, (b, h) -> Http.postJson(b + "/api/voice/speech", h, Http.obj("text", chunk))));
    return new Audio(r.body, r.contentType);
  }

  void streamSpeech(String text, Speaker speaker) throws IOException {
    ok(call(null, (b, h) -> Http.streamPostJson(b + "/api/voice/speech/stream", h, Http.obj("text", text), new Http.StreamConsumer() {
      public void opened(java.net.HttpURLConnection connection) throws IOException { speaker.openPcmConnection(connection); }
      public void closed(java.net.HttpURLConnection connection) { speaker.closePcmConnection(connection); }
      public void read(java.io.InputStream input, java.net.HttpURLConnection connection) throws IOException { speaker.playPcm(input, connection); }
    })));
  }

  Audio announcementAudio(String id) throws IOException {
    Http.Response r = ok(call(null, (b, h) ->
        Http.getJson(b + "/api/voice/announcements/" + Uri.encode(id) + "/audio", h)));
    return new Audio(r.body, r.contentType);
  }

  void support(String deviceId, boolean enabled) throws IOException {
    call(null, (b, h) -> Http.putJson(b + "/api/voice/support", h, Http.obj("device_id", deviceId, "enabled", enabled)));
  }

  /** 깨어 있는 대화를 이 단말이 맡고 있다 — 서버가 같은 답을 알림으로 한 번 더 읽지 않게. */
  void presence(String tabId, Operator op, boolean visible) throws IOException {
    Object session = op == null ? JSONObject.NULL
        : Http.obj("manager_id", op.managerId, "cli", op.cli, "session_id", op.sessionId);
    call(null, (b, h) -> Http.putJson(b + "/api/voice/presence", h,
        Http.obj("tab_id", tabId, "session", session, "visible", visible)));
  }
}
