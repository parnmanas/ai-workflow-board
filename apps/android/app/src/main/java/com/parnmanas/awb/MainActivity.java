package com.parnmanas.awb;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputFilter;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebBackForwardList;
import android.webkit.WebChromeClient;
import android.webkit.WebHistoryItem;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.parnmanas.awb.voice.VoiceService;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * AWB 앱의 화면 — 서버가 서빙하는 AWB 웹 화면 전체를 이 WebView 가 그대로 띄운다.
 *
 * 웹 빌드를 앱에 묶지 않는다: 화면은 서버 배포를 그대로 따라가고, 앱은 웹이 못 하는 것
 * (백그라운드 상시 음성 · 끊기지 않는 로그인 · 구글 로그인 왕복 · 알림 · 서버 목록)만 맡는다. 같은 오리진이라
 * CORS 도 필요 없다. 다른 사이트로 가는 링크는 Custom Tab 으로 연다 — 앱 화면이 외부 페이지로 바뀌지 않는다.
 *
 * 서버는 여러 개 둘 수 있다(Servers). 화면에는 "지금 서버" 하나를 띄우고, 전환하면 그 서버의 화면을 새로 연다 —
 * 서버마다 로그인이 따로 남아 있어 다시 로그인하지 않는다. 상시 음성도 지금 서버를 따라 옮겨 간다.
 */
public class MainActivity extends Activity {
  private static final int REQ_FILE = 10;
  private static final int REQ_VOICE_PERMS = 11;
  private static final int REQ_WEB_MIC = 12;
  private static final String BATTERY_ASKED = "battery_asked";
  private static final int MAX_SHORTCUTS = 4;
  private static final int PING_TIMEOUT_MS = 8000;

  private enum Panel { NONE, SERVERS, ADD, OFFLINE }

  private WebView web;
  private ScrollView panel;
  private ProgressBar progress;
  private TextView panelTitle;
  private TextView panelMessage;
  private LinearLayout serverList;
  private EditText serverInput;
  private EditText nameInput;
  private Button primaryButton;
  private Button secondaryButton;
  private Panel panelMode = Panel.NONE;

  private WebBridge bridge;
  private String bridgedOrigin = "";
  /** 지금 서버의 화면이 실패 없이 다 그려졌다 — 목록을 닫을 때 다시 읽지 않아도 된다. */
  private boolean webReady = false;
  /** loadApp 이 연 화면이 다 그려지면 덮고 있던 네이티브 화면을 걷는다 — 목록을 보는 중의 새로 고침은 걷지 않는다. */
  private boolean revealOnLoad = false;
  /** 다른 서버의 화면으로 바꿨다 — 다 그려지면 뒤로 가기 기록을 지운다(뒤로 가서 이전 서버의 화면이 뜨지 않게). */
  private boolean clearHistoryOnLoad = false;
  private String lastPath = "/";
  /** 서버마다 마지막으로 보던 화면 — 전환해 돌아오면 거기로. */
  private final Map<String, String> lastPaths = new HashMap<>();
  /** 서버 응답 확인(목록의 점) — 목록을 다시 그려도 남는다. 메인 스레드에서만 만진다. */
  private final Map<String, Boolean> reachable = new HashMap<>();
  private final Set<String> pinging = new HashSet<>();
  private boolean pageFailed = false;
  private ValueCallback<Uri[]> fileCallback;
  private PermissionRequest pendingWebMic;
  private final List<Runnable> pendingVoiceDone = new ArrayList<>();
  private String pendingVoiceServer = "";
  private final Handler main = new Handler(Looper.getMainLooper());
  // 응답 없는 서버 하나(로그아웃 · 삭제 알림)가 다른 일을 붙잡지 않게 줄을 하나로 세우지 않는다.
  private final ExecutorService io = Executors.newCachedThreadPool();
  private final ExecutorService pings = Executors.newFixedThreadPool(3);
  private Object backCallback;
  private boolean resumed = false;
  private Uri pendingLink;
  private final VoiceService.StatusListener voiceListener = () -> {
    Server s = bridgedServer();
    if (s != null) bridge.emit(Http.obj("event", "voice-status", "status", VoiceService.statusJson(this, s.id)));
  };

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    setContentView(R.layout.activity_main);
    View root = findViewById(R.id.root);
    web = findViewById(R.id.web);
    panel = findViewById(R.id.panel);
    progress = findViewById(R.id.progress);
    panelTitle = findViewById(R.id.panel_title);
    panelMessage = findViewById(R.id.panel_message);
    serverList = findViewById(R.id.server_list);
    serverInput = findViewById(R.id.server_input);
    nameInput = findViewById(R.id.name_input);
    primaryButton = findViewById(R.id.primary_button);
    secondaryButton = findViewById(R.id.secondary_button);

    applyInsets(root);
    bridge = new WebBridge(this);
    setupWebView();
    registerBack();
    VoiceService.addStatusListener(voiceListener);

    primaryButton.setOnClickListener(v -> {
      if (panelMode == Panel.SERVERS) showAddServer();
      else if (panelMode == Panel.ADD) submitAddServer();
      else loadApp(lastPath);
    });
    secondaryButton.setOnClickListener(v -> {
      if (panelMode == Panel.SERVERS) closePanel();
      else showServers();
    });
    nameInput.setOnEditorActionListener((v, actionId, event) -> {
      if (actionId != EditorInfo.IME_ACTION_GO || panelMode != Panel.ADD) return false;
      submitAddServer();
      return true;
    });

    if (Servers.active(this) == null) {
      showAddServer();
    } else if (!handleIntent(getIntent())) {
      loadApp("/");
    }
    publishShortcuts();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    Uri data = intent == null ? null : intent.getData();
    if (data != null && "awb".equalsIgnoreCase(data.getScheme()) && !resumed) {
      // 알림을 눌러 깨어나는 중 — WebView 가 다시 돌기 전에 보낸 이동은 페이지에 닿지 않는다. onResume 에서 한다.
      intent.setData(null);
      pendingLink = data;
      return;
    }
    handleIntent(intent);
  }

  @Override
  protected void onResume() {
    super.onResume();
    resumed = true;
    Uri link = pendingLink;
    pendingLink = null;
    if (link != null) main.postDelayed(() -> handleAwbUri(link), 300);
  }

  @Override
  protected void onPause() {
    resumed = false;
    super.onPause();
  }

  @Override
  protected void onStart() {
    super.onStart();
    AppState.setForeground(true);
    web.onResume();
    web.resumeTimers();
    // 상시 음성은 켜 둔 동안 늘 살아 있어야 한다 — OS 가 죽였거나 재부팅 뒤라면 여기서 되살린다
    // (마이크를 쓰는 포그라운드 서비스는 앱이 보이는 동안에만 시작할 수 있다).
    VoiceService.sync(this);
  }

  @Override
  protected void onStop() {
    // 숨은 동안 웹은 쉰다(소리 · 마이크는 서비스가 맡는다). 페이지는 hidden 이 된다.
    AppState.setForeground(false);
    web.onPause();
    // 숨는 순간의 visibilitychange 처리(마이크 놓기 · presence)가 돌 틈을 준 뒤 타이머를 세운다.
    main.postDelayed(() -> {
      if (!AppState.isForeground()) web.pauseTimers();
    }, 1500);
    super.onStop();
  }

  @Override
  protected void onDestroy() {
    VoiceService.removeStatusListener(voiceListener);
    bridge.shutdown();
    io.shutdownNow();
    pings.shutdownNow();
    if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
      getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback((OnBackInvokedCallback) backCallback);
    }
    web.destroy();
    super.onDestroy();
  }

  // ─── 화면 ────────────────────────────────────────────────────────────────

  @SuppressWarnings("deprecation")
  private void applyInsets(View root) {
    if (Build.VERSION.SDK_INT >= 30) {
      getWindow().setDecorFitsSystemWindows(false);
    } else {
      root.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
          | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }
    root.setOnApplyWindowInsetsListener((v, insets) -> {
      if (Build.VERSION.SDK_INT >= 30) {
        Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime()
            | WindowInsets.Type.displayCutout());
        v.setPadding(i.left, i.top, i.right, i.bottom);
        return WindowInsets.CONSUMED;
      }
      v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
          insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
      return insets.consumeSystemWindowInsets();
    });
  }

  private void setupWebView() {
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    s.setTextZoom(100);
    // 웹이 앱 안인지 동기적으로 알 수 있게 — window.AwbAndroid 와 함께 본다.
    s.setUserAgentString(s.getUserAgentString() + " AWBAndroid/" + BuildConfig.VERSION_NAME);
    CookieManager.getInstance().setAcceptCookie(true);
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    web.setBackgroundColor(0xff0f172a);

    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return route(request.getUrl());
      }

      @Override
      public void onPageStarted(WebView view, String url, Bitmap favicon) {
        bridge.onPageStarted();
        pageFailed = false;
        progress.setVisibility(View.VISIBLE);
      }

      @Override
      public void onPageFinished(WebView view, String url) {
        progress.setVisibility(View.GONE);
        Uri u = Uri.parse(url);
        // about:blank(서버를 지웠을 때) · 바꾸기 전 서버의 늦은 끝은 지금 서버의 화면이 아니다.
        if (pageFailed || !isBridged(u)) return;
        lastPath = pathOf(u);
        webReady = true;
        if (clearHistoryOnLoad) {
          clearHistoryOnLoad = false;
          view.clearHistory();
        }
        if (revealOnLoad) {
          revealOnLoad = false;
          hidePanel();
          web.setVisibility(View.VISIBLE);
        }
      }

      @Override
      public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
        // 화면 안 이동(pushState)도 따라간다 — 다시 시도 · 서버 재시작 · 서버 전환 뒤에 같은 화면으로 돌아오게.
        Uri u = Uri.parse(url);
        if (isBridged(u)) lastPath = pathOf(u);
      }

      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (!request.isForMainFrame() || !isBridged(request.getUrl())) return;
        pageFailed = true;
        webReady = false;
        showOffline(String.valueOf(error.getDescription()));
      }

      @Override
      public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        // 배포로 서버가 다시 뜨는 동안 터널이 502 를 낸다 — 그 페이지 대신 다시 시도 화면을 띄운다.
        if (!request.isForMainFrame() || response.getStatusCode() < 500 || !isBridged(request.getUrl())) return;
        pageFailed = true;
        webReady = false;
        showOffline("서버가 응답하지 않습니다 (HTTP " + response.getStatusCode() + ")");
        main.postDelayed(() -> {
          if (panelMode == Panel.OFFLINE) loadApp(lastPath);
        }, 5000);
      }

      @Override
      public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
        recreate();
        return true;
      }
    });

    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onPermissionRequest(PermissionRequest request) {
        main.post(() -> onWebPermission(request));
      }

      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        try {
          startActivityForResult(params.createIntent(), REQ_FILE);
          return true;
        } catch (ActivityNotFoundException e) {
          fileCallback = null;
          return false;
        }
      }
    });

    web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
        download(url, contentDisposition, mimeType));
  }

  private boolean isBridged(Uri u) {
    return !bridgedOrigin.isEmpty() && WebBridge.originOf(u).equals(bridgedOrigin);
  }

  private static String pathOf(Uri u) {
    String path = u.getEncodedPath() == null || u.getEncodedPath().isEmpty() ? "/" : u.getEncodedPath();
    return path + (u.getEncodedQuery() == null ? "" : "?" + u.getEncodedQuery());
  }

  /** 화면에 붙어 있는 서버 — 브릿지 요청 · 내려받기의 인증은 이 서버의 것이다. */
  private Server bridgedServer() {
    return Servers.byOrigin(this, bridgedOrigin);
  }

  private void registerBack() {
    if (Build.VERSION.SDK_INT >= 33) {
      OnBackInvokedCallback cb = this::goBack;
      getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb);
      backCallback = cb;
    }
  }

  @Override
  @SuppressWarnings("deprecation")
  // API 33+ gestures use registerBack(); this override is only the older Android fallback.
  @android.annotation.SuppressLint("GestureBackNavigation")
  public void onBackPressed() {
    goBack();
  }

  private void goBack() {
    if (panelMode == Panel.ADD && !Servers.list(this).isEmpty()) {
      showServers();
    } else if (panelMode == Panel.SERVERS && Servers.active(this) != null) {
      closePanel();
    } else if (panelMode == Panel.NONE && canGoBackWithinServer()) {
      web.goBack();
    } else {
      // 첫 화면에서 뒤로 — 앱을 끝내지 않고 뒤로 보낸다(상시 음성은 그대로 돈다).
      moveTaskToBack(true);
    }
  }

  /** 뒤로 가도 지금 서버 안인가 — 다른 서버의 화면으로 돌아가면 브릿지도 로그인도 없는 화면이 된다. */
  private boolean canGoBackWithinServer() {
    if (!web.canGoBack()) return false;
    WebBackForwardList list = web.copyBackForwardList();
    int i = list.getCurrentIndex();
    WebHistoryItem prev = i > 0 ? list.getItemAtIndex(i - 1) : null;
    return prev != null && isBridged(Uri.parse(prev.getUrl()));
  }

  /** 서버 화면 안의 이동은 그대로, 밖으로 나가는 링크는 Custom Tab, awb:// 는 앱이 처리한다. */
  private boolean route(Uri uri) {
    String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
    if ("awb".equals(scheme)) {
      handleAwbUri(uri);
      return true;
    }
    if ("http".equals(scheme) || "https".equals(scheme)) {
      if (isBridged(uri)) {
        // 예전 웹 빌드의 구글 버튼은 페이지째 이동한다 — WebView 안에서는 Google 이 막으므로 가로챈다.
        if ("/api/auth/oauth/google/start".equals(uri.getPath()) && uri.getQueryParameter("app") == null) {
          Server s = bridgedServer();
          if (s != null) GoogleLogin.start(this, s);
          return true;
        }
        return false;
      }
      openExternal(uri);
      return true;
    }
    try {
      Intent intent = "intent".equals(scheme)
          ? Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
          : new Intent(Intent.ACTION_VIEW, uri);
      intent.addCategory(Intent.CATEGORY_BROWSABLE);
      intent.setComponent(null);
      startActivity(intent);
    } catch (Exception ignored) {
      // 열 앱이 없다
    }
    return true;
  }

  private void openExternal(Uri uri) {
    try {
      new CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, uri);
    } catch (ActivityNotFoundException e) {
      try {
        startActivity(new Intent(Intent.ACTION_VIEW, uri));
      } catch (ActivityNotFoundException ignored) {
      }
    }
  }

  /** 지금 서버의 화면을 연다. 다 그려지면 덮고 있던 네이티브 화면(목록 · 오프라인)이 걷힌다. */
  void loadApp(String path) {
    Server s = Servers.active(this);
    if (s == null) {
      showAddServer();
      return;
    }
    String origin = s.origin();
    if (!origin.equals(bridgedOrigin)) {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
        if (!bridgedOrigin.isEmpty()) WebViewCompat.removeWebMessageListener(web, WebBridge.NAME);
        WebViewCompat.addWebMessageListener(web, WebBridge.NAME, Collections.singleton(origin), bridge);
      }
      clearHistoryOnLoad = true;
    }
    bridgedOrigin = origin;
    bridge.setOrigin(origin);
    lastPath = path == null || path.isEmpty() ? "/" : path;
    webReady = false;
    revealOnLoad = true;
    web.loadUrl(s.url + lastPath);
  }

  /** 지운 서버의 화면을 내린다 — 남은 서버는 사용자가 목록에서 고른다. */
  private void detachWeb() {
    if (!bridgedOrigin.isEmpty() && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.removeWebMessageListener(web, WebBridge.NAME);
    }
    bridgedOrigin = "";
    bridge.setOrigin("");
    webReady = false;
    revealOnLoad = false;
    clearHistoryOnLoad = true;
    web.loadUrl("about:blank");
  }

  // ─── 서버 목록 ────────────────────────────────────────────────────────────

  /** 그 서버로 옮겨 간다. path 가 없으면 그 서버에서 마지막으로 보던 화면으로. */
  void switchTo(String serverId, String path) {
    Server target = Servers.get(this, serverId);
    if (target == null) {
      showServers();
      return;
    }
    if (isShowing(target)) {
      if (path != null) openPath(path);
      else closePanel();
      return;
    }
    String to = path != null ? path : lastPaths.get(serverId);
    activate(target, to == null ? "/" : to);
    Toast.makeText(this, "서버 전환: " + target.label(), Toast.LENGTH_SHORT).show();
  }

  /** 지금 화면이 이 서버의 것인가. */
  private boolean isShowing(Server s) {
    Server active = Servers.active(this);
    return active != null && active.id.equals(s.id) && s.origin().equals(bridgedOrigin);
  }

  /** 그 서버를 지금 서버로 하고 화면을 새로 연다. 상시 음성도 따라 옮긴다. */
  private void activate(Server target, String path) {
    Server current = Servers.active(this);
    if (current != null && current.origin().equals(bridgedOrigin)) lastPaths.put(current.id, lastPath);
    Servers.setActive(this, target.id);
    loadApp(path);
    VoiceService.sync(this);
  }

  /** 지금 서버의 화면 안에서 그 경로로 — 떠 있으면 페이지를 다시 읽지 않고 웹이 옮겨 간다. */
  private void openPath(String path) {
    if (webReady && bridge.connected()) {
      bridge.emit(Http.obj("event", "navigate", "path", path));
      hidePanel();
      web.setVisibility(View.VISIBLE);
    } else {
      loadApp(path);
    }
  }

  /** 네이티브 화면을 닫고 지금 서버의 화면으로 돌아간다. */
  private void closePanel() {
    Server s = Servers.active(this);
    if (s == null) {
      showAddServer();
      return;
    }
    if (webReady && s.origin().equals(bridgedOrigin)) {
      hidePanel();
      web.setVisibility(View.VISIBLE);
    } else if (s.origin().equals(bridgedOrigin)) {
      loadApp(lastPath);
    } else {
      String to = lastPaths.get(s.id);
      loadApp(to == null ? "/" : to);
    }
  }

  void showServers() {
    if (Servers.list(this).isEmpty()) {
      showAddServer();
      return;
    }
    panelMode = Panel.SERVERS;
    panelTitle.setText(R.string.servers_title);
    panelMessage.setText(R.string.servers_message);
    serverList.setVisibility(View.VISIBLE);
    serverInput.setVisibility(View.GONE);
    nameInput.setVisibility(View.GONE);
    primaryButton.setText(R.string.add_server);
    primaryButton.setEnabled(true);
    secondaryButton.setText(R.string.close);
    secondaryButton.setVisibility(View.VISIBLE);
    renderServers();
    showPanel();
    checkReachability();
  }

  private void renderServers() {
    serverList.removeAllViews();
    Server active = Servers.active(this);
    for (Server s : Servers.list(this)) {
      View row = getLayoutInflater().inflate(R.layout.item_server, serverList, false);
      boolean current = active != null && active.id.equals(s.id);
      row.setTag(s.id);
      row.setBackgroundResource(current ? R.drawable.server_row_active_bg : R.drawable.server_row_bg);
      ((TextView) row.findViewById(R.id.server_name)).setText(s.label());
      ((TextView) row.findViewById(R.id.server_url)).setText(s.url);
      row.findViewById(R.id.server_badge).setVisibility(current ? View.VISIBLE : View.GONE);
      paintRow(row, s);
      final String id = s.id;
      row.setOnClickListener(v -> switchTo(id, null));
      row.setOnLongClickListener(v -> {
        showServerActions(id);
        return true;
      });
      row.findViewById(R.id.server_more).setOnClickListener(v -> showServerActions(id));
      serverList.addView(row);
    }
  }

  /** 응답 점 · 상태 줄 — 응답 확인이 끝날 때마다 그 줄만 다시 칠한다. */
  private void paintRow(View row, Server s) {
    Boolean up = reachable.get(s.id);
    int color = getColor(up == null ? R.color.text_muted : up ? R.color.server_up : R.color.server_down);
    row.findViewById(R.id.server_dot).setBackgroundTintList(ColorStateList.valueOf(color));
    StringBuilder status = new StringBuilder();
    if (!s.signedIn()) status.append("로그인 필요");
    else status.append(s.userLabel.isEmpty() ? "로그인됨" : s.userLabel);
    if (s.signedIn() && s.voiceEnabled) status.append(" · 상시 음성");
    if (Boolean.FALSE.equals(up)) status.append(" · 응답 없음");
    ((TextView) row.findViewById(R.id.server_status)).setText(status);
  }

  private void checkReachability() {
    for (Server s : Servers.list(this)) {
      if (!pinging.add(s.id)) continue;
      final String id = s.id;
      final String url = s.url;
      try {
        pings.execute(() -> {
          boolean up;
          try {
            up = Http.request("GET", url + "/api/health", null, null, null, PING_TIMEOUT_MS).ok();
          } catch (Exception e) {
            up = false;
          }
          final boolean result = up;
          main.post(() -> {
            pinging.remove(id);
            reachable.put(id, result);
            Server now = Servers.get(this, id);
            View row = serverList.findViewWithTag(id);
            if (panelMode == Panel.SERVERS && now != null && row != null) paintRow(row, now);
          });
        });
      } catch (RejectedExecutionException e) {
        pinging.remove(id);
      }
    }
  }

  private void showServerActions(String id) {
    Server s = Servers.get(this, id);
    if (s == null) return;
    Server active = Servers.active(this);
    boolean current = active != null && active.id.equals(id);
    List<String> labels = new ArrayList<>();
    List<Runnable> actions = new ArrayList<>();
    if (!current) {
      labels.add("이 서버로 전환");
      actions.add(() -> switchTo(id, null));
    }
    labels.add("이름 바꾸기");
    actions.add(() -> promptRename(id));
    if (s.signedIn()) {
      labels.add("로그아웃");
      actions.add(() -> confirmSignOut(id));
    }
    labels.add("목록에서 삭제");
    actions.add(() -> confirmRemove(id));
    new AlertDialog.Builder(this)
        .setTitle(s.label())
        .setItems(labels.toArray(new String[0]), (d, which) -> actions.get(which).run())
        .setNegativeButton(R.string.cancel, null)
        .show();
  }

  private void promptRename(String id) {
    Server s = Servers.get(this, id);
    if (s == null) return;
    EditText input = new EditText(this);
    input.setSingleLine(true);
    input.setFilters(new InputFilter[] { new InputFilter.LengthFilter(40) });
    input.setHint(ServerUrls.hostLabel(s.url));
    input.setText(s.name);
    input.setSelection(input.getText().length());
    FrameLayout box = new FrameLayout(this);
    box.setPadding(dp(20), dp(4), dp(20), 0);
    box.addView(input);
    new AlertDialog.Builder(this)
        .setTitle("이름 바꾸기")
        .setMessage("비우면 주소(" + ServerUrls.hostLabel(s.url) + ")로 보입니다.")
        .setView(box)
        .setPositiveButton("저장", (d, w) -> {
          Servers.rename(this, id, input.getText().toString());
          if (panelMode == Panel.SERVERS) renderServers();
          publishShortcuts();
        })
        .setNegativeButton(R.string.cancel, null)
        .show();
  }

  private void confirmSignOut(String id) {
    Server s = Servers.get(this, id);
    if (s == null) return;
    new AlertDialog.Builder(this)
        .setTitle(s.label() + " 로그아웃")
        .setMessage("이 단말의 로그인 자격을 회수합니다. 이 서버를 다시 쓰려면 로그인해야 합니다.")
        .setPositiveButton("로그아웃", (d, w) -> signOut(id))
        .setNegativeButton(R.string.cancel, null)
        .show();
  }

  private void signOut(String id) {
    Server active = Servers.active(this);
    boolean current = active != null && active.id.equals(id);
    if (current) VoiceService.stop(this);
    io.execute(() -> {
      Auth.signOut(this, id);
      main.post(() -> {
        // 화면은 아직 끝난 세션을 들고 있다 — 다음에 열 때 새로 읽어 로그인 화면이 되게 한다.
        if (current) webReady = false;
        if (panelMode == Panel.SERVERS) renderServers();
        else if (current) loadApp("/");
        Toast.makeText(this, "로그아웃했습니다", Toast.LENGTH_SHORT).show();
      });
    });
  }

  private void confirmRemove(String id) {
    Server s = Servers.get(this, id);
    if (s == null) return;
    new AlertDialog.Builder(this)
        .setTitle(s.label() + " 삭제")
        .setMessage("목록에서 지우고 이 단말의 로그인 자격도 회수합니다.")
        .setPositiveButton("삭제", (d, w) -> removeServer(id))
        .setNegativeButton(R.string.cancel, null)
        .show();
  }

  private void removeServer(String id) {
    Server active = Servers.active(this);
    boolean current = active != null && active.id.equals(id);
    Server gone = Servers.remove(this, id);
    if (gone == null) return;
    lastPaths.remove(id);
    reachable.remove(id);
    // 자격은 서버에 돌려주고(세션 끝 · 단말 회수), 이 오리진의 웹 저장소도 비운다.
    io.execute(() -> Auth.forget(gone));
    WebStorage.getInstance().deleteOrigin(gone.origin());
    ShortcutManager sm = getSystemService(ShortcutManager.class);
    if (sm != null) {
      try {
        sm.disableShortcuts(Collections.singletonList("server-" + id), "목록에서 삭제한 서버입니다");
      } catch (Exception ignored) {
      }
    }
    publishShortcuts();
    if (current) {
      detachWeb();
      // 상시 음성은 새 지금 서버(목록의 첫 서버)에 맞춘다.
      VoiceService.sync(this);
    }
    showServers();
  }

  // ─── 서버 추가 · 오프라인 ─────────────────────────────────────────────────

  void showAddServer() {
    boolean first = Servers.list(this).isEmpty();
    panelMode = Panel.ADD;
    panelTitle.setText(first ? R.string.connect_title : R.string.add_title);
    panelMessage.setText(first ? R.string.connect_message : R.string.add_message);
    serverList.setVisibility(View.GONE);
    serverInput.setText(first ? BuildConfig.DEFAULT_SERVER_URL : "");
    serverInput.setVisibility(View.VISIBLE);
    nameInput.setText("");
    nameInput.setVisibility(View.VISIBLE);
    primaryButton.setText(R.string.connect);
    primaryButton.setEnabled(true);
    secondaryButton.setText(R.string.cancel);
    secondaryButton.setVisibility(first ? View.GONE : View.VISIBLE);
    showPanel();
    if (!first) serverInput.requestFocus();
  }

  private void showOffline(String reason) {
    panelMode = Panel.OFFLINE;
    Server s = Servers.active(this);
    String where = s == null ? "" : (s.name.isEmpty() ? s.url : s.name + "\n" + s.url) + "\n";
    panelTitle.setText(R.string.offline_title);
    panelMessage.setText(where + (reason == null ? "" : reason));
    serverList.setVisibility(View.GONE);
    serverInput.setVisibility(View.GONE);
    nameInput.setVisibility(View.GONE);
    primaryButton.setText(R.string.retry);
    primaryButton.setEnabled(true);
    secondaryButton.setText(R.string.servers);
    secondaryButton.setVisibility(View.VISIBLE);
    showPanel();
  }

  private void showPanel() {
    panel.setVisibility(View.VISIBLE);
    panel.scrollTo(0, 0);
    web.setVisibility(View.INVISIBLE);
  }

  private void hidePanel() {
    panelMode = Panel.NONE;
    panel.setVisibility(View.GONE);
    InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
    if (imm != null) imm.hideSoftInputFromWindow(panel.getWindowToken(), 0);
  }

  private void submitAddServer() {
    final String url;
    try {
      url = ServerUrls.normalize(serverInput.getText().toString());
    } catch (IllegalArgumentException e) {
      panelMessage.setText(e.getMessage());
      return;
    }
    final String name = nameInput.getText().toString().trim();
    Server existing = Servers.byOrigin(this, ServerUrls.originOf(url));
    if (existing != null) {
      Toast.makeText(this, "이미 목록에 있는 서버입니다", Toast.LENGTH_SHORT).show();
      switchTo(existing.id, null);
      return;
    }
    primaryButton.setEnabled(false);
    panelMessage.setText("연결 확인 중…");
    io.execute(() -> {
      String error = null;
      try {
        Http.Response r = Http.request("GET", url + "/api/health", null, null, null, PING_TIMEOUT_MS);
        if (!r.ok()) error = "AWB 서버가 아닙니다 (HTTP " + r.code + ")";
        else if (!isHealth(r)) error = "AWB 서버가 아닙니다 — /api/health 가 AWB 의 응답이 아닙니다";
      } catch (Exception e) {
        error = "연결 실패 — 주소와 네트워크를 확인해 주세요";
      }
      final String err = error;
      main.post(() -> {
        primaryButton.setEnabled(true);
        if (panelMode != Panel.ADD) return;
        if (err != null) {
          panelMessage.setText(err);
          return;
        }
        Server added = Servers.add(this, url, name);
        reachable.put(added.id, true);
        publishShortcuts();
        switchTo(added.id, "/");
      });
    });
  }

  /** AWB 의 `/api/health` 는 `{status, database, …}` 다 — 아무 웹 서버의 200 을 AWB 로 받지 않게. */
  private static boolean isHealth(Http.Response r) {
    try {
      return r.json().has("status");
    } catch (Exception e) {
      return false;
    }
  }

  /** 앱 아이콘을 길게 누르면 서버 목록 — 서버가 둘 이상일 때만. 바로가기는 awb://servers/<id> 를 연다. */
  private void publishShortcuts() {
    ShortcutManager sm = getSystemService(ShortcutManager.class);
    if (sm == null) return;
    List<Server> servers = Servers.list(this);
    try {
      if (servers.size() < 2) {
        sm.removeAllDynamicShortcuts();
        return;
      }
      int max = Math.min(MAX_SHORTCUTS, sm.getMaxShortcutCountPerActivity());
      List<ShortcutInfo> out = new ArrayList<>();
      for (Server s : servers) {
        if (out.size() >= max) break;
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse("awb://servers/" + s.id), this, MainActivity.class);
        out.add(new ShortcutInfo.Builder(this, "server-" + s.id)
            .setShortLabel(s.label())
            .setLongLabel(s.label() + " 열기")
            .setIcon(Icon.createWithResource(this, R.mipmap.ic_launcher))
            .setIntent(open)
            .setRank(out.size())
            .build());
      }
      sm.setDynamicShortcuts(out);
    } catch (Exception ignored) {
      // 호출 횟수 제한 등 — 다음에 목록이 바뀔 때 다시 맞춘다.
    }
  }

  private int dp(int v) {
    return Math.round(v * getResources().getDisplayMetrics().density);
  }

  // ─── 딥링크 ──────────────────────────────────────────────────────────────

  /** @return 화면을 직접 띄웠는가(처음 실행이면 loadApp 을 대신한다) */
  private boolean handleIntent(Intent intent) {
    if (intent == null || intent.getData() == null) return false;
    Uri uri = intent.getData();
    if (!"awb".equalsIgnoreCase(uri.getScheme())) return false;
    intent.setData(null);
    return handleAwbUri(uri);
  }

  private boolean handleAwbUri(Uri uri) {
    String host = uri.getHost() == null ? "" : uri.getHost();
    if ("oauth".equals(host)) {
      finishGoogleLogin(uri);
      return false;
    }
    if ("servers".equals(host)) {
      // 바로가기 — awb://servers/<id>. id 가 없거나 지운 서버면 목록을 연다.
      List<String> segments = uri.getPathSegments();
      String id = segments.isEmpty() ? "" : segments.get(0);
      if (Servers.get(this, id) != null) {
        switchTo(id, null);
      } else {
        if (!id.isEmpty()) Toast.makeText(this, "목록에 없는 서버입니다", Toast.LENGTH_SHORT).show();
        showServers();
      }
      return true;
    }
    if ("sessions".equals(host)) {
      // 알림 링크는 어느 서버의 소식인지 `server` 로 싣는다 — 그사이 다른 서버로 옮겨 갔으면 그 서버로 돌아간다.
      String query = ServerUrls.withoutQueryParam(uri.getEncodedQuery(), "server");
      String path = "/sessions" + (uri.getEncodedPath() == null ? "" : uri.getEncodedPath())
          + (query.isEmpty() ? "" : "?" + query);
      String serverId = uri.getQueryParameter("server");
      Server active = Servers.active(this);
      if (serverId != null && Servers.get(this, serverId) != null && (active == null || !active.id.equals(serverId))) {
        switchTo(serverId, path);
        return true;
      }
      if (active == null) return false;
      if (isShowing(active)) openPath(path);
      else loadApp(path);
      return true;
    }
    return false;
  }

  private void finishGoogleLogin(Uri uri) {
    GoogleLogin.Pending pending = GoogleLogin.take(this);
    String error = uri.getQueryParameter("error");
    String code = uri.getQueryParameter("code");
    if (error != null || code == null) {
      Toast.makeText(this, "구글 로그인 실패: " + (error == null ? "코드 없음" : error.replace('_', ' ')),
          Toast.LENGTH_LONG).show();
      return;
    }
    // 로그인을 시작한 서버에서 바꾼다(2.1 에서 시작한 로그인은 서버가 적혀 있지 않다 — 지금 서버).
    Server server = Servers.get(this, pending.serverId);
    if (server == null) server = Servers.active(this);
    if (server == null) return;
    final String serverId = server.id;
    io.execute(() -> {
      String failure = null;
      try {
        String token = Auth.exchangeOAuthCode(this, serverId, code, pending.verifier);
        if (!Auth.onLoggedIn(this, serverId, token)) failure = "세션을 확인하지 못했습니다";
      } catch (Exception e) {
        failure = e.getMessage();
      }
      final String f = failure;
      main.post(() -> {
        Server s = Servers.get(this, serverId);
        if (f != null || s == null) {
          Toast.makeText(this, "구글 로그인 실패: " + (f == null ? "서버가 목록에 없습니다" : f), Toast.LENGTH_LONG).show();
          return;
        }
        // 웹은 부팅할 때 앱에 세션을 묻는다 — 새로 띄우면 로그인된 화면이 된다.
        activate(s, "/");
        onSignedIn(serverId);
      });
    });
  }

  // ─── 로그인 · 상시 음성 ─────────────────────────────────────────────────

  /** 그 서버에 로그인이 끝났고 단말 자격도 받았다. 그 서버에서 처음이면 상시 음성을 켠다(권한은 OS 가 묻는다). */
  void onSignedIn(String serverId) {
    Server s = Servers.get(this, serverId);
    Server active = Servers.active(this);
    // 그사이 다른 서버로 옮겨 갔다 — 상시 음성은 지금 서버의 것이다.
    if (s == null || active == null || !active.id.equals(serverId)) return;
    if (!s.voiceAsked) enableVoice(serverId, null);
    else VoiceService.sync(this);
  }

  void enableVoice(String serverId, Runnable done) {
    List<String> missing = new ArrayList<>();
    if (!hasPermission(Manifest.permission.RECORD_AUDIO)) missing.add(Manifest.permission.RECORD_AUDIO);
    if (Build.VERSION.SDK_INT >= 33 && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
      missing.add(Manifest.permission.POST_NOTIFICATIONS);
    }
    if (missing.isEmpty()) {
      startVoice(serverId);
      if (done != null) done.run();
      return;
    }
    if (done != null) pendingVoiceDone.add(done);
    pendingVoiceServer = serverId;
    requestPermissions(missing.toArray(new String[0]), REQ_VOICE_PERMS);
  }

  private void startVoice(String serverId) {
    Servers.setVoiceEnabled(this, serverId, true);
    VoiceService.sync(this);
    askBatteryOnce();
  }

  void disableVoice(String serverId) {
    Servers.setVoiceEnabled(this, serverId, false);
    VoiceService.sync(this);
  }

  /** 절전 예외가 없으면 OS 가 몇 시간 뒤 서비스를 재운다. 한 번만 묻는다(설정에서 다시 열 수 있다). */
  private void askBatteryOnce() {
    if (getPreferences(Context.MODE_PRIVATE).getBoolean(BATTERY_ASKED, false)) return;
    getPreferences(Context.MODE_PRIVATE).edit().putBoolean(BATTERY_ASKED, true).apply();
    if (isBatteryOptimized(this)) openBatterySettings();
  }

  public static boolean isBatteryOptimized(Context c) {
    PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
    return pm != null && !pm.isIgnoringBatteryOptimizations(c.getPackageName());
  }

  void openBatterySettings() {
    try {
      startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
          Uri.parse("package:" + getPackageName())));
    } catch (Exception e) {
      try {
        startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
      } catch (Exception ignored) {
      }
    }
  }

  private boolean hasPermission(String perm) {
    return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
  }

  private void onWebPermission(PermissionRequest request) {
    boolean audio = false;
    for (String r : request.getResources()) {
      if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
    }
    if (!audio || !isBridged(request.getOrigin())) {
      request.deny();
      return;
    }
    if (hasPermission(Manifest.permission.RECORD_AUDIO)) {
      request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
      return;
    }
    if (pendingWebMic != null) pendingWebMic.deny();
    pendingWebMic = request;
    requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_WEB_MIC);
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    boolean mic = hasPermission(Manifest.permission.RECORD_AUDIO);
    if (requestCode == REQ_WEB_MIC && pendingWebMic != null) {
      if (mic) pendingWebMic.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
      else pendingWebMic.deny();
      pendingWebMic = null;
    }
    if (requestCode == REQ_VOICE_PERMS) {
      String serverId = pendingVoiceServer;
      pendingVoiceServer = "";
      if (mic) {
        startVoice(serverId);
      } else {
        Servers.setVoiceEnabled(this, serverId, false);
        Toast.makeText(this, "마이크 권한이 없어 상시 듣기를 켜지 못했습니다", Toast.LENGTH_LONG).show();
      }
      List<Runnable> done = new ArrayList<>(pendingVoiceDone);
      pendingVoiceDone.clear();
      for (Runnable r : done) r.run();
      voiceListener.onStatusChanged();
    }
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode == REQ_FILE && fileCallback != null) {
      fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
      fileCallback = null;
    }
  }

  // ─── 내려받기 ────────────────────────────────────────────────────────────

  private void download(String url, String contentDisposition, String mimeType) {
    Uri uri = Uri.parse(url);
    String scheme = uri.getScheme() == null ? "" : uri.getScheme();
    if (!"http".equals(scheme) && !"https".equals(scheme)) {
      Toast.makeText(this, "이 파일은 앱에서 내려받을 수 없습니다", Toast.LENGTH_LONG).show();
      return;
    }
    // 지금 서버의 파일에만 그 서버의 세션을 붙인다 — 다른 사이트로 토큰을 보내지 않는다.
    Server ours = isBridged(uri) ? bridgedServer() : null;
    io.execute(() -> {
      DownloadManager.Request r = new DownloadManager.Request(uri);
      if (mimeType != null && !mimeType.isEmpty()) r.setMimeType(mimeType);
      if (ours != null) {
        String token = Auth.token(this, ours.id);
        if (!token.isEmpty()) r.addRequestHeader("Authorization", "Bearer " + token);
      }
      r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
      r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
          URLUtil.guessFileName(url, contentDisposition, mimeType));
      DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
      if (dm != null) dm.enqueue(r);
      main.post(() -> Toast.makeText(this, "내려받는 중…", Toast.LENGTH_SHORT).show());
    });
  }
}
