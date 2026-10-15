package com.parnmanas.awb;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
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
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * AWB 앱의 화면 — 서버가 서빙하는 AWB 웹 화면 전체를 이 WebView 가 그대로 띄운다.
 *
 * 웹 빌드를 앱에 묶지 않는다: 화면은 서버 배포를 그대로 따라가고, 앱은 웹이 못 하는 것
 * (백그라운드 상시 음성 · 끊기지 않는 로그인 · 구글 로그인 왕복 · 알림)만 맡는다. 같은 오리진이라
 * CORS 도 서버 주소 설정도 필요 없다. 다른 사이트로 가는 링크는 Custom Tab 으로 연다 — 앱 화면이
 * 외부 페이지로 바뀌지 않는다.
 */
public class MainActivity extends Activity {
  private static final int REQ_FILE = 10;
  private static final int REQ_VOICE_PERMS = 11;
  private static final int REQ_WEB_MIC = 12;
  private static final String BATTERY_ASKED = "battery_asked";

  private enum Panel { NONE, SETUP, OFFLINE }

  private WebView web;
  private View panel;
  private ProgressBar progress;
  private TextView panelTitle;
  private TextView panelMessage;
  private EditText serverInput;
  private Button primaryButton;
  private Button secondaryButton;
  private Panel panelMode = Panel.NONE;

  private WebBridge bridge;
  private String bridgedOrigin = "";
  private String lastPath = "/";
  private boolean pageFailed = false;
  private ValueCallback<Uri[]> fileCallback;
  private PermissionRequest pendingWebMic;
  private final List<Runnable> pendingVoiceDone = new ArrayList<>();
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private Object backCallback;
  private boolean resumed = false;
  private Uri pendingLink;
  private final VoiceService.StatusListener voiceListener = status ->
      bridge.emit(Http.obj("event", "voice-status", "status", status));

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
    serverInput = findViewById(R.id.server_input);
    primaryButton = findViewById(R.id.primary_button);
    secondaryButton = findViewById(R.id.secondary_button);

    applyInsets(root);
    bridge = new WebBridge(this);
    setupWebView();
    registerBack();
    VoiceService.addStatusListener(voiceListener);

    primaryButton.setOnClickListener(v -> {
      if (panelMode == Panel.SETUP) connect(serverInput.getText().toString());
      else loadApp(lastPath);
    });
    secondaryButton.setOnClickListener(v -> showServerSetup());

    if (Prefs.serverUrl(this).isEmpty()) {
      showServerSetup();
    } else if (!handleIntent(getIntent())) {
      loadApp("/");
    }
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
    if (Prefs.voiceEnabled(this) && !Prefs.deviceToken(this).isEmpty() && hasPermission(Manifest.permission.RECORD_AUDIO)) {
      VoiceService.start(this);
    }
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
        if (pageFailed) return;
        Uri u = Uri.parse(url);
        if (WebBridge.originOf(u).equals(bridgedOrigin)) {
          String path = u.getEncodedPath() == null ? "/" : u.getEncodedPath();
          lastPath = path + (u.getEncodedQuery() == null ? "" : "?" + u.getEncodedQuery());
        }
        hidePanel();
        web.setVisibility(View.VISIBLE);
      }

      @Override
      public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
        // 화면 안 이동(pushState)도 따라간다 — 다시 시도 · 서버 재시작 뒤에 같은 화면으로 돌아오게.
        Uri u = Uri.parse(url);
        if (!WebBridge.originOf(u).equals(bridgedOrigin)) return;
        String path = u.getEncodedPath() == null ? "/" : u.getEncodedPath();
        lastPath = path + (u.getEncodedQuery() == null ? "" : "?" + u.getEncodedQuery());
      }

      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (!request.isForMainFrame()) return;
        pageFailed = true;
        showOffline(String.valueOf(error.getDescription()));
      }

      @Override
      public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        // 배포로 서버가 다시 뜨는 동안 터널이 502 를 낸다 — 그 페이지 대신 다시 시도 화면을 띄운다.
        if (!request.isForMainFrame() || response.getStatusCode() < 500) return;
        pageFailed = true;
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

  private void registerBack() {
    if (Build.VERSION.SDK_INT >= 33) {
      OnBackInvokedCallback cb = this::goBack;
      getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb);
      backCallback = cb;
    }
  }

  @Override
  @SuppressWarnings("deprecation")
  public void onBackPressed() {
    goBack();
  }

  private void goBack() {
    if (panelMode == Panel.SETUP && !Prefs.serverUrl(this).isEmpty()) {
      loadApp(lastPath);
    } else if (panelMode == Panel.NONE && web.canGoBack()) {
      web.goBack();
    } else {
      // 첫 화면에서 뒤로 — 앱을 끝내지 않고 뒤로 보낸다(상시 음성은 그대로 돈다).
      moveTaskToBack(true);
    }
  }

  /** 서버 화면 안의 이동은 그대로, 밖으로 나가는 링크는 Custom Tab, awb:// 는 앱이 처리한다. */
  private boolean route(Uri uri) {
    String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
    if ("awb".equals(scheme)) {
      handleAwbUri(uri);
      return true;
    }
    if ("http".equals(scheme) || "https".equals(scheme)) {
      if (WebBridge.originOf(uri).equals(bridgedOrigin)) {
        // 예전 웹 빌드의 구글 버튼은 페이지째 이동한다 — WebView 안에서는 Google 이 막으므로 가로챈다.
        if ("/api/auth/oauth/google/start".equals(uri.getPath()) && uri.getQueryParameter("app") == null) {
          GoogleLogin.start(this);
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

  void loadApp(String path) {
    String server = Prefs.serverUrl(this);
    if (server.isEmpty()) {
      showServerSetup();
      return;
    }
    String origin = WebBridge.originOf(Uri.parse(server));
    if (!origin.equals(bridgedOrigin) && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      if (!bridgedOrigin.isEmpty()) WebViewCompat.removeWebMessageListener(web, WebBridge.NAME);
      WebViewCompat.addWebMessageListener(web, WebBridge.NAME, Collections.singleton(origin), bridge);
    }
    bridgedOrigin = origin;
    bridge.setOrigin(origin);
    lastPath = path == null || path.isEmpty() ? "/" : path;
    web.loadUrl(server + lastPath);
  }

  // ─── 서버 주소 · 오프라인 ─────────────────────────────────────────────────

  void showServerSetup() {
    panelMode = Panel.SETUP;
    panelTitle.setText(R.string.connect_title);
    panelMessage.setText(R.string.connect_message);
    String current = Prefs.serverUrl(this);
    serverInput.setText(current.isEmpty() ? BuildConfig.DEFAULT_SERVER_URL : current);
    serverInput.setVisibility(View.VISIBLE);
    primaryButton.setText(R.string.connect);
    primaryButton.setEnabled(true);
    secondaryButton.setVisibility(View.GONE);
    panel.setVisibility(View.VISIBLE);
    web.setVisibility(View.INVISIBLE);
  }

  private void showOffline(String reason) {
    panelMode = Panel.OFFLINE;
    panelTitle.setText(R.string.offline_title);
    panelMessage.setText(Prefs.serverUrl(this) + "\n" + (reason == null ? "" : reason));
    serverInput.setVisibility(View.GONE);
    primaryButton.setText(R.string.retry);
    primaryButton.setEnabled(true);
    secondaryButton.setVisibility(View.VISIBLE);
    panel.setVisibility(View.VISIBLE);
    web.setVisibility(View.INVISIBLE);
  }

  private void hidePanel() {
    panelMode = Panel.NONE;
    panel.setVisibility(View.GONE);
  }

  private void connect(String raw) {
    final String url;
    try {
      url = normalizeServerUrl(raw);
    } catch (IllegalArgumentException e) {
      panelMessage.setText(e.getMessage());
      return;
    }
    primaryButton.setEnabled(false);
    panelMessage.setText("연결 확인 중…");
    io.execute(() -> {
      String error = null;
      try {
        Http.Response r = Http.getJson(url + "/api/health", null);
        if (!r.ok()) error = "AWB 서버가 아닙니다 (HTTP " + r.code + ")";
      } catch (Exception e) {
        error = "연결 실패 — 주소와 네트워크를 확인해 주세요";
      }
      final String err = error;
      main.post(() -> {
        primaryButton.setEnabled(true);
        if (err != null) {
          panelMessage.setText(err);
          return;
        }
        if (!url.equals(Prefs.serverUrl(this))) {
          // 다른 서버의 자격은 여기서 쓸 수 없다.
          VoiceService.stop(this);
          String old = Prefs.serverUrl(this);
          if (!old.isEmpty()) io.execute(() -> Auth.onLoggedOut(this));
          else Prefs.clearAuth(this);
          Prefs.setServerUrl(this, url);
        }
        loadApp("/");
      });
    });
  }

  static String normalizeServerUrl(String raw) {
    String v = raw == null ? "" : raw.trim();
    while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
    if (v.isEmpty()) throw new IllegalArgumentException("서버 주소를 입력해 주세요");
    if (!v.contains("://")) v = "https://" + v;
    Uri u = Uri.parse(v);
    String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
    if (!("http".equals(scheme) || "https".equals(scheme)) || u.getHost() == null || u.getHost().isEmpty()) {
      throw new IllegalArgumentException("주소가 올바르지 않습니다. 예: https://awb.example.com");
    }
    String path = u.getEncodedPath() == null ? "" : u.getEncodedPath();
    return WebBridge.originOf(u) + (path.equals("/") ? "" : path);
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
    if ("sessions".equals(host)) {
      String path = "/sessions" + (uri.getEncodedPath() == null ? "" : uri.getEncodedPath())
          + (uri.getEncodedQuery() == null ? "" : "?" + uri.getEncodedQuery());
      if (bridge.connected()) {
        bridge.emit(Http.obj("event", "navigate", "path", path));
      } else {
        loadApp(path);
      }
      return true;
    }
    return false;
  }

  private void finishGoogleLogin(Uri uri) {
    String error = uri.getQueryParameter("error");
    String code = uri.getQueryParameter("code");
    if (error != null || code == null) {
      Toast.makeText(this, "구글 로그인 실패: " + (error == null ? "코드 없음" : error.replace('_', ' ')),
          Toast.LENGTH_LONG).show();
      return;
    }
    String verifier = GoogleLogin.takeVerifier(this);
    io.execute(() -> {
      String failure = null;
      try {
        String token = Auth.exchangeOAuthCode(this, code, verifier);
        if (!Auth.onLoggedIn(this, token)) failure = "세션을 확인하지 못했습니다";
      } catch (Exception e) {
        failure = e.getMessage();
      }
      final String f = failure;
      main.post(() -> {
        if (f != null) {
          Toast.makeText(this, "구글 로그인 실패: " + f, Toast.LENGTH_LONG).show();
          return;
        }
        // 웹은 부팅할 때 앱에 세션을 묻는다 — 새로 띄우면 로그인된 화면이 된다.
        loadApp("/");
        onSignedIn();
      });
    });
  }

  // ─── 로그인 · 상시 음성 ─────────────────────────────────────────────────

  /** 로그인이 끝났고 단말 자격도 받았다. 처음이면 상시 음성을 켠다(권한은 OS 가 묻는다). */
  void onSignedIn() {
    if (!Prefs.voiceAsked(this)) {
      enableVoice(null);
    } else if (Prefs.voiceEnabled(this) && hasPermission(Manifest.permission.RECORD_AUDIO)) {
      VoiceService.start(this);
    }
  }

  void enableVoice(Runnable done) {
    List<String> missing = new ArrayList<>();
    if (!hasPermission(Manifest.permission.RECORD_AUDIO)) missing.add(Manifest.permission.RECORD_AUDIO);
    if (Build.VERSION.SDK_INT >= 33 && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
      missing.add(Manifest.permission.POST_NOTIFICATIONS);
    }
    if (missing.isEmpty()) {
      startVoice();
      if (done != null) done.run();
      return;
    }
    if (done != null) pendingVoiceDone.add(done);
    requestPermissions(missing.toArray(new String[0]), REQ_VOICE_PERMS);
  }

  private void startVoice() {
    Prefs.setVoiceEnabled(this, true);
    VoiceService.start(this);
    askBatteryOnce();
  }

  void disableVoice() {
    Prefs.setVoiceEnabled(this, false);
    VoiceService.stop(this);
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
    if (!audio || !WebBridge.originOf(request.getOrigin()).equals(bridgedOrigin)) {
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
      if (mic) {
        startVoice();
      } else {
        Prefs.setVoiceEnabled(this, false);
        Toast.makeText(this, "마이크 권한이 없어 상시 듣기를 켜지 못했습니다", Toast.LENGTH_LONG).show();
      }
      List<Runnable> done = new ArrayList<>(pendingVoiceDone);
      pendingVoiceDone.clear();
      for (Runnable r : done) r.run();
      bridge.emit(Http.obj("event", "voice-status", "status", VoiceService.statusJson(this)));
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
    boolean ours = WebBridge.originOf(uri).equals(bridgedOrigin);
    io.execute(() -> {
      DownloadManager.Request r = new DownloadManager.Request(uri);
      if (mimeType != null && !mimeType.isEmpty()) r.setMimeType(mimeType);
      if (ours) {
        String token = Auth.token(this);
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

  JSONObject voiceStatus() {
    return VoiceService.statusJson(this);
  }
}
