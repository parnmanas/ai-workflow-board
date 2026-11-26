package com.parnmanas.awb;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.view.Gravity;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import java.util.function.Consumer;

/** Unprivileged browser for dashboards: no AWB bridge, user-agent marker, tokens or injected scripts. */
final class WebPageView extends FrameLayout {
  private final WebView web;
  private final ProgressBar progress;
  private final LinearLayout error;
  private final TextView reason;
  private WebPage page;
  private boolean clearHistory;
  private String location = "";
  private String failedUrl = "";

  @SuppressLint("SetJavaScriptEnabled")
  WebPageView(Context context, Consumer<Uri> external, Consumer<String> onLocation) {
    super(context);
    web = new WebView(context);
    web.setId(R.id.custom_web);
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setBuiltInZoomControls(true);
    settings.setDisplayZoomControls(false);
    web.setBackgroundColor(context.getColor(R.color.surface));
    addView(web, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
    progress = new ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal);
    progress.setIndeterminate(true);
    addView(progress, new LayoutParams(LayoutParams.MATCH_PARENT, dp(3)));
    error = new LinearLayout(context);
    error.setOrientation(LinearLayout.VERTICAL);
    error.setGravity(Gravity.CENTER);
    error.setPadding(dp(24), dp(24), dp(24), dp(24));
    error.setBackgroundColor(context.getColor(R.color.surface));
    reason = new TextView(context);
    reason.setTextColor(context.getColor(R.color.text_primary));
    reason.setGravity(Gravity.CENTER);
    error.addView(reason);
    Button retry = new Button(context);
    retry.setText(R.string.retry);
    retry.setOnClickListener(v -> reload());
    error.addView(retry);
    Button browser = new Button(context);
    browser.setText(R.string.open_browser);
    browser.setOnClickListener(v -> { if (page != null) external.accept(Uri.parse(page.url)); });
    error.addView(browser);
    error.setVisibility(GONE);
    addView(error, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
    web.setWebChromeClient(new WebChromeClient() {
      @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
    });
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        String scheme = request.getUrl().getScheme();
        return !"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme);
      }

      @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
        location = url;
        onLocation.accept(url);
        // Chromium can report the HTTP error before announcing that navigation has started.
        if (!url.equals(failedUrl)) clearFailure();
        progress.setVisibility(url.equals(failedUrl) ? GONE : VISIBLE);
      }

      @Override public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
        location = url;
        onLocation.accept(url);
      }

      @Override public void onPageFinished(WebView view, String url) {
        if (!url.equals(view.getUrl())) return;
        progress.setVisibility(GONE);
        if (clearHistory) {
          clearHistory = false;
          view.clearHistory();
        }
      }

      @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError failure) {
        if (request.isForMainFrame()) failed(request.getUrl().toString(), String.valueOf(failure.getDescription()));
      }

      @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        if (request.isForMainFrame() && response.getStatusCode() >= 500) {
          failed(request.getUrl().toString(), "HTTP " + response.getStatusCode());
        }
      }

      @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError sslError) {
        handler.cancel();
        if (sslError.getUrl().equals(view.getUrl())) failed(sslError.getUrl(), "사이트 인증서를 확인할 수 없습니다");
      }
    });
    web.setDownloadListener((url, agent, disposition, mime, size) -> {
      if (!ServerUrls.originOf(url).isEmpty()) external.accept(Uri.parse(url));
    });
  }

  void show(WebPage target, boolean goHome) {
    boolean changed = page == null || !page.id.equals(target.id) || !page.url.equals(target.url);
    page = target;
    if (changed || goHome) {
      web.stopLoading();
      if (changed) clearHistory = true;
      location = target.url;
      clearFailure();
      web.loadUrl(target.url);
    }
  }

  String location() { return location; }
  void reload() {
    clearFailure();
    if (!location.isEmpty()) web.loadUrl(location);
  }
  boolean goBack() {
    if (clearHistory || !web.canGoBack()) return false;
    clearFailure();
    web.goBack();
    return true;
  }
  void resume() { web.onResume(); }
  void pause() { web.onPause(); }
  void destroy() { web.destroy(); }

  private void clearFailure() {
    failedUrl = "";
    error.setVisibility(GONE);
  }

  private void failed(String url, String message) {
    failedUrl = url;
    progress.setVisibility(GONE);
    reason.setText(getContext().getString(R.string.page_offline) + "\n\n" + message);
    error.setVisibility(VISIBLE);
  }

  private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
