package com.parnmanas.awb;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;
import androidx.browser.customtabs.CustomTabsIntent;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * 구글 로그인 — Google 은 WebView 안의 로그인을 막는다(disallowed_useragent). 그래서 시스템 브라우저
 * (Custom Tab)로 `start?app=android` 를 열고, 서버가 `awb://oauth?code=…` 로 앱에 돌려준다.
 * 코드는 PKCE 로 묶여 있어 verifier 를 가진 이 앱만 세션으로 바꿀 수 있다.
 */
public final class GoogleLogin {
  private static final String PREFS = "awb_oauth";
  private static final String VERIFIER = "verifier";

  private GoogleLogin() {}

  public static void start(Activity activity) {
    String verifier = randomVerifier();
    // Custom Tab 이 떠 있는 동안 앱 프로세스가 죽을 수 있다 — verifier 는 디스크에 둔다.
    prefs(activity).edit().putString(VERIFIER, verifier).apply();
    Uri uri = Uri.parse(Prefs.serverUrl(activity) + "/api/auth/oauth/google/start").buildUpon()
        .appendQueryParameter("app", "android")
        .appendQueryParameter("code_challenge", challenge(verifier))
        .build();
    new CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, uri);
  }

  /** 한 번만 꺼낸다 — 같은 verifier 로 두 번 바꿀 수 없게. */
  public static String takeVerifier(Context c) {
    SharedPreferences p = prefs(c);
    String v = p.getString(VERIFIER, "");
    p.edit().remove(VERIFIER).apply();
    return v;
  }

  private static SharedPreferences prefs(Context c) {
    return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private static String randomVerifier() {
    byte[] bytes = new byte[48];
    new SecureRandom().nextBytes(bytes);
    return b64url(bytes);
  }

  private static String challenge(String verifier) {
    try {
      MessageDigest md = MessageDigest.getInstance("SHA-256");
      return b64url(md.digest(verifier.getBytes(StandardCharsets.US_ASCII)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  private static String b64url(byte[] bytes) {
    return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
  }
}
