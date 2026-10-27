package com.parnmanas.awb;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import com.parnmanas.awb.voice.VoiceService;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 웹 화면 ↔ 앱 — `window.AwbAndroid` (androidx.webkit WebMessageListener).
 *
 * 지금 서버 오리진의 최상위 문서에만 주입된다(다른 사이트로 나가면 객체가 없다). 웹은 `{id, type, …}` 를
 * postMessage 하고, 앱은 `{id, ok, result | error}` 로 답한다. 앱이 먼저 알리는 것은 `{event, …}`
 * (음성 상태 변화 · 알림을 눌러 세션으로 가기). 웹 쪽 짝은 `apps/client/src/native/androidBridge.ts`.
 *
 * 요청은 그것을 보낸 오리진의 서버에 대해 처리하고, 답은 그 요청을 보낸 문서에만 보낸다 — 답을 기다리는 사이
 * 다른 서버로 옮겨 가도 한 서버의 토큰이 다른 서버의 화면에 닿지 않는다.
 */
public final class WebBridge implements WebViewCompat.WebMessageListener {
  public static final String NAME = "AwbAndroid";

  private final MainActivity activity;
  private final Handler main = new Handler(Looper.getMainLooper());
  /** 서버마다 한 줄 — 같은 서버의 요청은 온 순서대로, 응답 없는 서버가 다른 서버의 요청을 붙잡지 않게. */
  private final Map<String, ExecutorService> io = new ConcurrentHashMap<>();
  private JavaScriptReplyProxy proxy;
  private String origin = "";

  WebBridge(MainActivity activity) {
    this.activity = activity;
  }

  void setOrigin(String origin) {
    this.origin = origin;
    this.proxy = null;
  }

  /** 페이지가 바뀌면 이전 문서의 proxy 는 쓸 수 없다. */
  void onPageStarted() {
    proxy = null;
  }

  boolean connected() {
    return proxy != null;
  }

  @Override
  public void onPostMessage(WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame,
      JavaScriptReplyProxy replyProxy) {
    if (!isMainFrame || !origin.equals(originOf(sourceOrigin))) return;
    proxy = replyProxy;
    String data = message.getData();
    if (data == null) return;
    JSONObject req;
    try {
      req = new JSONObject(data);
    } catch (JSONException e) {
      return;
    }
    handle(replyProxy, req.optString("id", ""), req.optString("type", ""), req);
  }

  private void handle(JavaScriptReplyProxy to, String id, String type, JSONObject req) {
    Server s = Servers.byOrigin(activity, origin);
    if (s == null) {
      replyError(to, id, "no_server");
      return;
    }
    switch (type) {
      case "hello":
        reply(to, id, Http.obj(
            "app", "android",
            "version", BuildConfig.VERSION_NAME,
            "version_code", BuildConfig.VERSION_CODE,
            "server", s.url,
            "server_id", s.id,
            "server_name", s.label(),
            "servers", Servers.list(activity).size(),
            "voice", VoiceService.statusJson(activity, s.id)));
        break;
      case "session.get":
        run(s, () -> reply(to, id, Http.obj("token", Auth.token(activity, s.id))));
        break;
      case "session.refresh":
        run(s, () -> reply(to, id, Http.obj("token", Auth.refresh(activity, s.id, req.optString("rejected", "")))));
        break;
      case "session.loggedIn":
        run(s, () -> {
          boolean device;
          try {
            device = Auth.onLoggedIn(activity, s.id, req.optString("token", ""));
          } catch (Exception e) {
            device = false;
          }
          reply(to, id, Http.obj("device", device));
          if (device) main.post(() -> activity.onSignedIn(s.id));
        });
        break;
      case "session.loggedOut":
        VoiceService.stop(activity);
        run(s, () -> {
          Auth.onLoggedOut(activity, s.id);
          reply(to, id, new JSONObject());
        });
        break;
      case "voice.status":
        reply(to, id, VoiceService.statusJson(activity, s.id));
        break;
      case "voice.setEnabled":
        if (req.optBoolean("enabled", false)) {
          activity.enableVoice(s.id, () -> reply(to, id, VoiceService.statusJson(activity, s.id)));
        } else {
          activity.disableVoice(s.id);
          reply(to, id, VoiceService.statusJson(activity, s.id));
        }
        break;
      case "voice.batterySettings":
        activity.openBatterySettings();
        reply(to, id, new JSONObject());
        break;
      case "server.change":
        // 예전 이름 그대로 — 이제 서버 목록(전환 · 추가 · 관리)을 연다.
        reply(to, id, new JSONObject());
        main.post(activity::showServers);
        break;
      case "oauth.google":
        reply(to, id, new JSONObject());
        main.post(() -> GoogleLogin.start(activity, s));
        break;
      default:
        replyError(to, id, "unknown_type");
    }
  }

  private void run(Server s, Runnable task) {
    ExecutorService e = io.computeIfAbsent(s.id, k -> Executors.newSingleThreadExecutor());
    try {
      e.execute(task);
    } catch (RejectedExecutionException ignored) {
      // 화면이 닫히는 중
    }
  }

  /** 앱 → 웹 알림. 페이지가 아직 연결 전이면 버린다(웹은 연결할 때 상태를 다시 묻는다). */
  void emit(JSONObject event) {
    main.post(() -> {
      if (proxy == null) return;
      try {
        proxy.postMessage(event.toString());
      } catch (Exception ignored) {
        proxy = null;
      }
    });
  }

  private void reply(JavaScriptReplyProxy to, String id, JSONObject result) {
    send(to, Http.obj("id", id, "ok", true, "result", result));
  }

  private void replyError(JavaScriptReplyProxy to, String id, String error) {
    send(to, Http.obj("id", id, "ok", false, "error", error));
  }

  private void send(JavaScriptReplyProxy to, JSONObject out) {
    main.post(() -> {
      try {
        to.postMessage(out.toString());
      } catch (Exception ignored) {
        // 문서가 바뀌었다 — 새 문서가 다시 물어본다.
      }
    });
  }

  static String originOf(Uri uri) {
    if (uri == null || uri.getScheme() == null || uri.getHost() == null) return "";
    return ServerUrls.origin(uri.getScheme(), uri.getHost(), uri.getPort());
  }

  void shutdown() {
    for (ExecutorService e : io.values()) e.shutdownNow();
  }
}
