package com.parnmanas.awb.voice;

import android.content.Context;
import com.parnmanas.awb.Auth;
import com.parnmanas.awb.Server;
import com.parnmanas.awb.Servers;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * 서버 이벤트 스트림(`GET /api/events/stream`) — 웹 화면의 EventSource 와 같은 줄을 앱이 직접 듣는다.
 * 사용자 세션 토큰이어야 `agent_session_*` · `voice_announcement` 가 온다(웹과 같은 필터).
 *
 * 서버는 15초마다 ping 을 보낸다 — 60초 동안 아무것도 오지 않으면 끊긴 것으로 보고 다시 붙는다.
 * 재시작(배포) 뒤에는 토큰이 무효라 401 이 오고, 그때 단말 자격으로 세션을 다시 받는다.
 */
final class EventStream {
  interface Handler {
    void onEvent(String type, JSONObject data);

    void onConnected();
  }

  private static final int READ_TIMEOUT_MS = 60_000;

  private final Context ctx;
  private final String serverId;
  private final Handler handler;
  private volatile boolean running = false;
  private volatile HttpURLConnection conn;
  private Thread thread;

  EventStream(Context ctx, String serverId, Handler handler) {
    this.ctx = ctx.getApplicationContext();
    this.serverId = serverId;
    this.handler = handler;
  }

  synchronized void start() {
    if (running) return;
    running = true;
    thread = new Thread(this::loop, "awb-events");
    thread.start();
  }

  synchronized void stop() {
    running = false;
    HttpURLConnection c = conn;
    if (c != null) {
      try {
        c.disconnect();
      } catch (Exception ignored) {
      }
    }
    if (thread != null) thread.interrupt();
    thread = null;
  }

  private void loop() {
    long backoff = 1000;
    while (running) {
      String rejected = null;
      try {
        Server server = Servers.get(ctx, serverId);
        String token = server == null ? "" : Auth.token(ctx, serverId);
        if (token.isEmpty()) {
          sleep(30_000);
          continue;
        }
        HttpURLConnection c = (HttpURLConnection) new URL(server.url + "/api/events/stream").openConnection();
        conn = c;
        c.setConnectTimeout(10_000);
        c.setReadTimeout(READ_TIMEOUT_MS);
        c.setRequestProperty("Accept", "text/event-stream");
        c.setRequestProperty("Authorization", "Bearer " + token);
        int code = c.getResponseCode();
        if (code == 401) {
          rejected = token;
        } else if (code == 200) {
          backoff = 1000;
          handler.onConnected();
          read(c);
        }
      } catch (Exception ignored) {
        // 끊김 — 아래에서 다시 붙는다.
      } finally {
        HttpURLConnection c = conn;
        conn = null;
        if (c != null) c.disconnect();
      }
      if (!running) break;
      if (rejected != null) {
        if (Auth.refresh(ctx, serverId, rejected).isEmpty()) {
          sleep(60_000);
          continue;
        }
      }
      sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  private void read(HttpURLConnection c) throws Exception {
    try (BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
      String event = "message";
      StringBuilder data = new StringBuilder();
      String line;
      while (running && (line = in.readLine()) != null) {
        if (line.isEmpty()) {
          if (data.length() > 0) dispatch(event, data.toString());
          event = "message";
          data.setLength(0);
        } else if (line.startsWith("event:")) {
          event = line.substring(6).trim();
        } else if (line.startsWith("data:")) {
          if (data.length() > 0) data.append('\n');
          data.append(line.substring(5).startsWith(" ") ? line.substring(6) : line.substring(5));
        }
      }
    }
  }

  private void dispatch(String type, String data) {
    if (!"agent_session_event".equals(type) && !"agent_session_update".equals(type)
        && !"voice_announcement".equals(type)) {
      return;
    }
    try {
      handler.onEvent(type, new JSONObject(data));
    } catch (Exception ignored) {
      // 모양이 틀린 이벤트 하나 때문에 스트림을 끊지 않는다.
    }
  }

  private void sleep(long ms) {
    try {
      Thread.sleep(ms);
    } catch (InterruptedException ignored) {
    }
  }
}
