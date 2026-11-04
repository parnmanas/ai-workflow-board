package com.parnmanas.awb;

import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import com.parnmanas.awb.voice.VoiceService;
import java.util.Map;
import java.util.concurrent.Callable;
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
  /** 내려받기 · 클립보드 — 한 줄로 돈다: 조각은 온 순서대로 이어 써야 한다. */
  private final ExecutorService files = Executors.newSingleThreadExecutor();
  private final Downloads downloads = new Downloads();
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
      // ─── 내려받기 · 클립보드 — 웹이 들고 있는 바이트(blob:)를 받는다 ───
      case "file.begin":
        if (Downloads.needsLegacyPermission(activity)) {
          // Android 8–9 — 권한을 묻고, 웹은 다시 누르라고 알린다(대화상자 동안 전송을 붙잡지 않는다).
          main.post(activity::requestStoragePermission);
          replyError(to, id, "storage_permission");
          break;
        }
        onFiles(to, id, () -> Http.obj("transfer",
            downloads.begin(activity, req.optString("name", ""), req.optString("mime", ""), req.optLong("size", -1))));
        break;
      case "file.chunk":
        onFiles(to, id, () -> {
          downloads.write(activity, req.optString("transfer", ""), Base64.decode(req.optString("base64", ""), Base64.DEFAULT));
          return new JSONObject();
        });
        break;
      case "file.end":
        onFiles(to, id, () -> {
          String saved = downloads.end(activity, req.optString("transfer", ""), req.optBoolean("complete", false));
          if (!saved.isEmpty()) {
            main.post(() -> Toast.makeText(activity, "다운로드 폴더에 저장했습니다 — " + saved, Toast.LENGTH_SHORT).show());
          }
          return Http.obj("name", saved);
        });
        break;
      case "download.url":
        // http(s) 주소(원격 영상 등) — 시스템 DownloadManager 로. 지금 서버의 주소에만 그 서버의 세션을 붙인다.
        main.post(() -> activity.downloadUrl(req.optString("url", ""), req.optString("name", ""), req.optString("mime", "")));
        reply(to, id, new JSONObject());
        break;
      case "clipboard.image":
        onFiles(to, id, () -> {
          ClipboardImages.copy(activity, Base64.decode(req.optString("base64", ""), Base64.DEFAULT), req.optString("mime", ""));
          // 13 부터는 시스템이 복사한 그림을 미리 보여 준다 — 같은 알림을 두 번 띄우지 않는다.
          if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            main.post(() -> Toast.makeText(activity, "이미지를 복사했습니다", Toast.LENGTH_SHORT).show());
          }
          return new JSONObject();
        });
        break;
      default:
        replyError(to, id, "unknown_type");
    }
  }

  /** 파일 일은 한 줄로 돌리고, 실패는 사유 코드(IOException 메시지)로 답한다. */
  private void onFiles(JavaScriptReplyProxy to, String id, Callable<JSONObject> task) {
    try {
      files.execute(() -> {
        try {
          reply(to, id, task.call());
        } catch (Exception e) {
          String reason = e.getMessage();
          replyError(to, id, reason == null || reason.isEmpty() ? "io_error" : reason);
        }
      });
    } catch (RejectedExecutionException e) {
      replyError(to, id, "closing");
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
    // 쓰다 만 내려받기는 남기지 않는다 — 줄에 남은 일을 마친 뒤 지운다.
    try {
      files.execute(() -> downloads.abortAll(activity));
    } catch (RejectedExecutionException ignored) {
      // 이미 닫혔다
    }
    files.shutdown();
  }
}
