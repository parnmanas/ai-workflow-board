package com.parnmanas.awb;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import com.parnmanas.awb.voice.VoiceService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 웹 화면 ↔ 앱 — `window.AwbAndroid` (androidx.webkit WebMessageListener).
 *
 * 서버 오리진의 최상위 문서에만 주입된다(다른 사이트로 나가면 객체가 없다). 웹은 `{id, type, …}` 를
 * postMessage 하고, 앱은 `{id, ok, result | error}` 로 답한다. 앱이 먼저 알리는 것은 `{event, …}`
 * (음성 상태 변화 · 알림을 눌러 세션으로 가기). 웹 쪽 짝은 `apps/client/src/native/androidBridge.ts`.
 */
public final class WebBridge implements WebViewCompat.WebMessageListener {
  public static final String NAME = "AwbAndroid";

  private final MainActivity activity;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService io = Executors.newSingleThreadExecutor();
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
    handle(req.optString("id", ""), req.optString("type", ""), req);
  }

  private void handle(String id, String type, JSONObject req) {
    switch (type) {
      case "hello":
        reply(id, Http.obj(
            "app", "android",
            "version", BuildConfig.VERSION_NAME,
            "version_code", BuildConfig.VERSION_CODE,
            "server", Prefs.serverUrl(activity),
            "voice", VoiceService.statusJson(activity)));
        break;
      case "session.get":
        io.execute(() -> reply(id, Http.obj("token", Auth.token(activity))));
        break;
      case "session.refresh":
        io.execute(() -> reply(id, Http.obj("token", Auth.refresh(activity, req.optString("rejected", "")))));
        break;
      case "session.loggedIn":
        io.execute(() -> {
          boolean device;
          try {
            device = Auth.onLoggedIn(activity, req.optString("token", ""));
          } catch (Exception e) {
            device = false;
          }
          reply(id, Http.obj("device", device));
          if (device) main.post(activity::onSignedIn);
        });
        break;
      case "session.loggedOut":
        VoiceService.stop(activity);
        io.execute(() -> {
          Auth.onLoggedOut(activity);
          reply(id, new JSONObject());
        });
        break;
      case "voice.status":
        reply(id, VoiceService.statusJson(activity));
        break;
      case "voice.setEnabled":
        if (req.optBoolean("enabled", false)) {
          activity.enableVoice(() -> reply(id, VoiceService.statusJson(activity)));
        } else {
          activity.disableVoice();
          reply(id, VoiceService.statusJson(activity));
        }
        break;
      case "voice.batterySettings":
        activity.openBatterySettings();
        reply(id, new JSONObject());
        break;
      case "server.change":
        reply(id, new JSONObject());
        main.post(activity::showServerSetup);
        break;
      case "oauth.google":
        reply(id, new JSONObject());
        main.post(() -> GoogleLogin.start(activity));
        break;
      default:
        replyError(id, "unknown_type");
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

  private void reply(String id, JSONObject result) {
    JSONObject out = Http.obj("id", id, "ok", true, "result", result);
    send(out);
  }

  private void replyError(String id, String error) {
    send(Http.obj("id", id, "ok", false, "error", error));
  }

  private void send(JSONObject out) {
    final JavaScriptReplyProxy target = proxy;
    main.post(() -> {
      if (target == null) return;
      try {
        target.postMessage(out.toString());
      } catch (Exception ignored) {
        // 문서가 바뀌었다 — 새 문서가 다시 물어본다.
      }
    });
  }

  static String originOf(Uri uri) {
    if (uri == null || uri.getScheme() == null || uri.getHost() == null) return "";
    String scheme = uri.getScheme().toLowerCase();
    int port = uri.getPort();
    boolean defaultPort = port < 0 || ("https".equals(scheme) && port == 443) || ("http".equals(scheme) && port == 80);
    return scheme + "://" + uri.getHost().toLowerCase() + (defaultPort ? "" : ":" + port);
  }

  void shutdown() {
    io.shutdownNow();
  }
}
