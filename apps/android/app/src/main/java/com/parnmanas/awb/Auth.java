package com.parnmanas.awb;

import android.content.Context;
import android.os.Build;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

/**
 * 서버마다의 세션 토큰의 단일 출처 — 화면(WebView)과 상시 음성 서비스가 같은 토큰을 쓴다.
 *
 * AWB 세션은 서버 메모리에만 있어 24시간 뒤나 서버 재시작(배포) 때 끊긴다. 앱은 로그인할 때
 * 단말 자격(`POST /api/auth/devices`)을 받아 두고, 끊기면 그것으로 새 세션을 받는다
 * (`POST /api/auth/devices/session`). 그래서 배포가 몇 번 지나가도 다시 로그인하지 않는다.
 * 자격은 서버마다 따로다 — 한 서버의 단말 토큰을 다른 서버로 보내지 않는다.
 *
 * 전부 동기 호출이다 — UI 스레드에서 부르지 말 것. 잠금도 서버마다 따로라, 응답 없는 서버 하나가 다른
 * 서버의 토큰 요청을 붙잡지 않는다.
 */
public final class Auth {
  private static final long VALIDATE_EVERY_MS = 5 * 60_000L;
  private static final Map<String, Object> LOCKS = new ConcurrentHashMap<>();
  private static final Map<String, Long> VALIDATED_AT = new ConcurrentHashMap<>();

  private Auth() {}

  private static Object lock(String serverId) {
    return LOCKS.computeIfAbsent(serverId, k -> new Object());
  }

  public static Map<String, String> headers(String token) {
    Map<String, String> h = new HashMap<>();
    if (token != null && !token.isEmpty()) h.put("Authorization", "Bearer " + token);
    return h;
  }

  /** 지금 쓸 수 있는 세션 토큰. 없거나(로그인 전) 회수됐으면 "". 네트워크가 안 되면 가진 것을 준다. */
  public static String token(Context c, String serverId) {
    synchronized (lock(serverId)) {
      Server s = Servers.get(c, serverId);
      if (s == null) return "";
      String token = s.sessionToken;
      Long at = VALIDATED_AT.get(serverId);
      if (!token.isEmpty() && at != null && System.currentTimeMillis() - at < VALIDATE_EVERY_MS) return token;
      if (!token.isEmpty()) {
        try {
          Http.Response r = Http.getJson(s.url + "/api/auth/me", headers(token));
          if (r.ok()) {
            VALIDATED_AT.put(serverId, System.currentTimeMillis());
            // 2.1 에서 옮겨 온 서버는 누가 로그인했는지 모른다 — 목록에 보이도록 채운다.
            if (s.userLabel.isEmpty()) Servers.setUserLabel(c, serverId, userLabel(r.json()));
            return token;
          }
          if (r.code != 401) return token;
        } catch (IOException e) {
          return token;
        }
      }
      return mintLocked(c, s);
    }
  }

  /** 401 을 받은 쪽이 부른다 — 단말 자격으로 새 세션을 받는다. 자격이 없거나 회수됐으면 "". */
  public static String refresh(Context c, String serverId, String rejected) {
    synchronized (lock(serverId)) {
      Server s = Servers.get(c, serverId);
      if (s == null) return "";
      // 다른 스레드가 이미 새로 받았다.
      if (!s.sessionToken.isEmpty() && !s.sessionToken.equals(rejected)) return s.sessionToken;
      return mintLocked(c, s);
    }
  }

  private static String mintLocked(Context c, Server s) {
    if (s.deviceToken.isEmpty()) {
      Servers.setSessionToken(c, s.id, "");
      return "";
    }
    try {
      Http.Response r = Http.postJson(s.url + "/api/auth/devices/session", null,
          Http.obj("device_token", s.deviceToken, "app_version", BuildConfig.VERSION_NAME));
      if (r.ok()) {
        String token = r.json().optString("token", "");
        Servers.setSessionToken(c, s.id, token);
        VALIDATED_AT.put(s.id, System.currentTimeMillis());
        return token;
      }
      if (r.code == 401) {
        // 회수됐다(다른 단말에서 지웠거나 사용자가 막혔다) — 이 서버에는 다시 로그인해야 한다.
        Servers.clearAuth(c, s.id);
      }
      return "";
    } catch (IOException e) {
      return s.sessionToken;
    }
  }

  /**
   * 화면에서 로그인이 끝났다. 세션 토큰을 받아 두고, 이 사용자의 단말 자격이 없으면 받는다.
   * @return 단말 자격이 준비됐는가
   */
  public static boolean onLoggedIn(Context c, String serverId, String token) throws IOException {
    if (token == null || token.isEmpty()) return false;
    Server s = Servers.get(c, serverId);
    if (s == null) return false;
    Http.Response me = Http.getJson(s.url + "/api/auth/me", headers(token));
    if (!me.ok()) return false;
    JSONObject user = me.json();
    String userId = user.optString("id", "");
    synchronized (lock(serverId)) {
      s = Servers.get(c, serverId);
      if (s == null) return false;
      Servers.setSessionToken(c, serverId, token);
      VALIDATED_AT.put(serverId, System.currentTimeMillis());
      if (!s.deviceToken.isEmpty() && userId.equals(s.deviceUserId)) {
        Servers.setUserLabel(c, serverId, userLabel(user));
        return true;
      }
      if (!s.deviceToken.isEmpty()) revokeQuietly(s);
      Http.Response r = Http.postJson(s.url + "/api/auth/devices", headers(token),
          Http.obj("name", deviceName(), "platform", "android", "app_version", BuildConfig.VERSION_NAME));
      if (!r.ok()) return false;
      JSONObject j = r.json();
      Servers.setDevice(c, serverId, j.optString("device_id", ""), j.optString("device_token", ""), userId, userLabel(user));
      return true;
    }
  }

  /**
   * 화면에서 로그아웃했다 — 웹이 세션을 끝내기 직전에 부른다(그래서 아직 세션이 산 동안 정리할 수 있다).
   * 단말 자격을 회수하고 다 잊는다. 세션 자체는 웹이 이어서 끝낸다.
   */
  public static void onLoggedOut(Context c, String serverId) {
    synchronized (lock(serverId)) {
      Server s = Servers.get(c, serverId);
      if (s == null) return;
      release(s, false);
      Servers.clearAuth(c, serverId);
      VALIDATED_AT.remove(serverId);
    }
  }

  /** 서버 목록에서 로그아웃했다 — 화면을 거치지 않으므로 세션도 여기서 끝낸다. */
  public static void signOut(Context c, String serverId) {
    synchronized (lock(serverId)) {
      Server s = Servers.get(c, serverId);
      if (s == null) return;
      release(s, true);
      Servers.clearAuth(c, serverId);
      VALIDATED_AT.remove(serverId);
    }
  }

  /** 목록에서 지운 서버(스냅샷)의 자격을 서버에 돌려준다. 닿지 않아도 이 단말은 이미 잊었다. */
  public static void forget(Server removed) {
    synchronized (lock(removed.id)) {
      release(removed, true);
      VALIDATED_AT.remove(removed.id);
    }
  }

  /**
   * 이 단말이 그 서버에서 손을 뗀다 — 음성 지원을 끄고, 세션을 끝내고(endSession), 단말 자격을 회수한다.
   * 전부 최선 시도다.
   *
   * 음성 지원을 켠 채 사라진 단말은 서버가 계속 "듣는 단말이 있다" 고 보고 operator 에게 아무도 듣지 않는 보고를
   * 이어 보낸다(VoiceSupportService 는 남은 단말이 없으면 마지막 선택을 따른다). 그래서 켜 두었던 서버에만 끈다고
   * 알린다 — 켠 적 없는 단말이 "꺼짐" 을 처음 알리면 오히려 그 사용자의 보고가 멈춘다.
   */
  private static void release(Server s, boolean endSession) {
    String token = s.sessionToken;
    boolean minted = false;
    if (s.voiceEnabled && !s.deviceId.isEmpty()) {
      int code = supportOff(s, token);
      if (code == 401 && !s.deviceToken.isEmpty()) {
        // 세션이 이미 끊겼다(배포 재시작) — 작별 인사만 하려고 한 번 받는다. 받은 세션은 아래에서 끝낸다.
        token = mintQuietly(s);
        minted = !token.isEmpty();
        if (minted) supportOff(s, token);
      }
    }
    if ((endSession || minted) && !token.isEmpty()) {
      try {
        Http.postJson(s.url + "/api/auth/logout", headers(token), new JSONObject());
      } catch (IOException ignored) {
      }
    }
    revokeQuietly(s);
  }

  /** @return HTTP 상태. 닿지 않았으면 0, 토큰이 없으면 401. */
  private static int supportOff(Server s, String token) {
    if (token.isEmpty()) return 401;
    try {
      return Http.putJson(s.url + "/api/voice/support", headers(token),
          Http.obj("device_id", "android-" + s.deviceId, "enabled", false)).code;
    } catch (IOException e) {
      return 0;
    }
  }

  private static String mintQuietly(Server s) {
    try {
      Http.Response r = Http.postJson(s.url + "/api/auth/devices/session", null,
          Http.obj("device_token", s.deviceToken, "app_version", BuildConfig.VERSION_NAME));
      return r.ok() ? r.json().optString("token", "") : "";
    } catch (IOException e) {
      return "";
    }
  }

  private static void revokeQuietly(Server s) {
    if (s.deviceToken.isEmpty()) return;
    try {
      Http.postJson(s.url + "/api/auth/devices/revoke", null, Http.obj("device_token", s.deviceToken));
    } catch (IOException ignored) {
      // 서버에 닿지 않아도 이 단말은 잊는다 — 서버 쪽 자격은 Settings 의 단말 목록에서 지울 수 있다.
    }
  }

  /** Custom Tab 구글 로그인의 마지막 단계 — `awb://oauth?code=` 의 코드를 그 서버의 세션 토큰으로 바꾼다. */
  public static String exchangeOAuthCode(Context c, String serverId, String code, String verifier) throws IOException {
    Server s = Servers.get(c, serverId);
    if (s == null) throw new IOException("서버가 목록에 없습니다");
    Http.Response r = Http.postJson(s.url + "/api/auth/oauth/app/exchange", null,
        Http.obj("code", code, "code_verifier", verifier));
    if (!r.ok()) throw new IOException(r.errorText());
    return r.json().optString("token", "");
  }

  /** `/api/auth/me` → 목록에 보일 "이름 · 이메일". */
  static String userLabel(JSONObject me) {
    String name = me.optString("name", "").trim();
    String email = me.optString("email", "").trim();
    if (name.isEmpty()) return email;
    if (email.isEmpty() || email.equalsIgnoreCase(name)) return name;
    return name + " · " + email;
  }

  public static String deviceName() {
    String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
    String model = Build.MODEL == null ? "Android" : Build.MODEL;
    return model.toLowerCase().startsWith(maker.toLowerCase()) ? model : (maker + " " + model).trim();
  }
}
