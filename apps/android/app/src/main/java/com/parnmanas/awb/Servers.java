package com.parnmanas.awb;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * 등록된 AWB 서버 목록과 서버마다의 자격 — 앱 private 저장소.
 *
 * 서버마다 단말 자격 · 세션 토큰 · 상시 음성 스위치를 따로 둔다 — 다른 서버로 옮겨 가도 이 서버의 로그인이
 * 남아 있어 돌아올 때 다시 로그인하지 않는다. "지금 서버"(active)는 하나이고, 화면(WebView)과 상시 음성이
 * 그 서버를 쓴다.
 *
 * 단말 토큰은 WebView localStorage 와 같은 민감도다(루팅된 단말에서는 둘 다 보인다). 서버는 원문을 갖고
 * 있지 않고, 로그아웃 · 서버 삭제 · "단말 회수" 로 즉시 무효가 된다.
 *
 * 키: `servers`(보이는 순서대로 id 를 쉼표로) · `active_server` · `s.<id>.<field>`. 쓰기는 전부 LOCK 안에서
 * 하고 목록에 없는 id 에는 쓰지 않는다 — 늦게 끝난 스레드가 지운 서버의 자격을 되살리지 않게.
 */
public final class Servers {
  private static final String FILE = "awb_app";
  private static final String LIST = "servers";
  private static final String ACTIVE = "active_server";

  private static final String URL = "url";
  private static final String NAME = "name";
  private static final String DEVICE_ID = "device_id";
  private static final String DEVICE_TOKEN = "device_token";
  private static final String DEVICE_USER_ID = "device_user_id";
  private static final String USER_LABEL = "user_label";
  private static final String SESSION_TOKEN = "session_token";
  private static final String VOICE_ENABLED = "voice_enabled";
  private static final String VOICE_ASKED = "voice_asked";
  private static final String[] FIELDS = {
      URL, NAME, DEVICE_ID, DEVICE_TOKEN, DEVICE_USER_ID, USER_LABEL, SESSION_TOKEN, VOICE_ENABLED, VOICE_ASKED };

  /** ≤ 2.1 은 서버가 하나였다 — 이 최상위 키들을 처음 열 때 서버 하나로 옮기고 지운다. */
  private static final String LEGACY_URL = "server_url";
  private static final String[] LEGACY = {
      LEGACY_URL, DEVICE_ID, DEVICE_TOKEN, DEVICE_USER_ID, SESSION_TOKEN, VOICE_ENABLED, VOICE_ASKED };

  private static final Object LOCK = new Object();
  private static volatile boolean migrated = false;

  private Servers() {}

  // ─── 읽기 ────────────────────────────────────────────────────────────────

  public static List<Server> list(Context c) {
    SharedPreferences p = p(c);
    List<Server> out = new ArrayList<>();
    for (String id : ids(p)) {
      Server s = read(p, id);
      if (s != null) out.add(s);
    }
    return out;
  }

  /** 목록에 없으면(지웠으면) null. */
  public static Server get(Context c, String id) {
    if (id == null || id.isEmpty()) return null;
    SharedPreferences p = p(c);
    return ids(p).contains(id) ? read(p, id) : null;
  }

  /** 지금 서버. 목록이 비었으면 null. */
  public static Server active(Context c) {
    SharedPreferences p = p(c);
    List<String> ids = ids(p);
    if (ids.isEmpty()) return null;
    String id = p.getString(ACTIVE, "");
    return read(p, ids.contains(id) ? id : ids.get(0));
  }

  public static Server byOrigin(Context c, String origin) {
    if (origin == null || origin.isEmpty()) return null;
    for (Server s : list(c)) {
      if (s.origin().equals(origin)) return s;
    }
    return null;
  }

  // ─── 목록 ────────────────────────────────────────────────────────────────

  /** 추가한다. 같은 오리진이 이미 있으면 그것을 돌려준다(한 오리진에 서버 하나). */
  public static Server add(Context c, String url, String name) {
    synchronized (LOCK) {
      SharedPreferences p = p(c);
      String origin = ServerUrls.originOf(url);
      List<String> ids = ids(p);
      for (String id : ids) {
        Server s = read(p, id);
        if (s != null && s.origin().equals(origin)) return s;
      }
      String id = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
      ids.add(id);
      p.edit()
          .putString(LIST, String.join(",", ids))
          .putString(k(id, URL), url)
          .putString(k(id, NAME), name == null ? "" : name.trim())
          .apply();
      return read(p, id);
    }
  }

  public static void setActive(Context c, String id) {
    synchronized (LOCK) {
      SharedPreferences p = p(c);
      if (ids(p).contains(id)) p.edit().putString(ACTIVE, id).apply();
    }
  }

  public static void rename(Context c, String id, String name) {
    write(c, id, e -> e.putString(k(id, NAME), name == null ? "" : name.trim()));
  }

  /**
   * 목록에서 지운다. 지운 서버의 스냅샷(자격 포함)을 돌려준다 — 부른 쪽이 그것으로 서버에 자격 회수를 알린다.
   * 지금 서버였으면 목록의 첫 서버가 지금 서버가 된다.
   */
  public static Server remove(Context c, String id) {
    synchronized (LOCK) {
      SharedPreferences p = p(c);
      List<String> ids = ids(p);
      if (!ids.contains(id)) return null;
      Server gone = read(p, id);
      ids.remove(id);
      SharedPreferences.Editor e = p.edit().putString(LIST, String.join(",", ids));
      for (String f : FIELDS) e.remove(k(id, f));
      if (id.equals(p.getString(ACTIVE, ""))) {
        if (ids.isEmpty()) e.remove(ACTIVE);
        else e.putString(ACTIVE, ids.get(0));
      }
      e.apply();
      return gone;
    }
  }

  // ─── 서버마다의 자격 · 스위치 ─────────────────────────────────────────────

  public static void setSessionToken(Context c, String id, String token) {
    write(c, id, e -> e.putString(k(id, SESSION_TOKEN), token == null ? "" : token));
  }

  public static void setDevice(Context c, String id, String deviceId, String token, String userId, String userLabel) {
    write(c, id, e -> e.putString(k(id, DEVICE_ID), deviceId)
        .putString(k(id, DEVICE_TOKEN), token)
        .putString(k(id, DEVICE_USER_ID), userId)
        .putString(k(id, USER_LABEL), userLabel));
  }

  public static void setUserLabel(Context c, String id, String userLabel) {
    write(c, id, e -> e.putString(k(id, USER_LABEL), userLabel));
  }

  /** 로그아웃 — 이 서버에서 받은 자격을 버린다. 주소 · 이름 · 음성 스위치는 남긴다. */
  public static void clearAuth(Context c, String id) {
    write(c, id, e -> e.remove(k(id, DEVICE_ID))
        .remove(k(id, DEVICE_TOKEN))
        .remove(k(id, DEVICE_USER_ID))
        .remove(k(id, USER_LABEL))
        .remove(k(id, SESSION_TOKEN)));
  }

  public static void setVoiceEnabled(Context c, String id, boolean on) {
    write(c, id, e -> e.putBoolean(k(id, VOICE_ENABLED), on).putBoolean(k(id, VOICE_ASKED), true));
  }

  // ─── 내부 ────────────────────────────────────────────────────────────────

  private interface Edit {
    void apply(SharedPreferences.Editor e);
  }

  private static void write(Context c, String id, Edit edit) {
    synchronized (LOCK) {
      SharedPreferences p = p(c);
      if (!ids(p).contains(id)) return;
      SharedPreferences.Editor e = p.edit();
      edit.apply(e);
      e.apply();
    }
  }

  private static String k(String id, String field) {
    return "s." + id + "." + field;
  }

  private static List<String> ids(SharedPreferences p) {
    List<String> out = new ArrayList<>();
    for (String id : p.getString(LIST, "").split(",")) {
      if (!id.isEmpty()) out.add(id);
    }
    return out;
  }

  private static Server read(SharedPreferences p, String id) {
    String url = p.getString(k(id, URL), "");
    if (url.isEmpty()) return null;
    return new Server(id, url,
        p.getString(k(id, NAME), ""),
        p.getString(k(id, DEVICE_ID), ""),
        p.getString(k(id, DEVICE_TOKEN), ""),
        p.getString(k(id, DEVICE_USER_ID), ""),
        p.getString(k(id, USER_LABEL), ""),
        p.getString(k(id, SESSION_TOKEN), ""),
        p.getBoolean(k(id, VOICE_ENABLED), false),
        p.getBoolean(k(id, VOICE_ASKED), false));
  }

  private static SharedPreferences p(Context c) {
    SharedPreferences p = c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    if (!migrated) migrate(p);
    return p;
  }

  /** 2.1 까지의 단일 서버 → 목록의 첫 서버. 로그인 · 상시 음성 스위치를 그대로 옮겨 업데이트 뒤에도 이어진다. */
  private static void migrate(SharedPreferences p) {
    synchronized (LOCK) {
      if (migrated) return;
      if (!p.contains(LIST) && p.contains(LEGACY_URL)) {
        String url = p.getString(LEGACY_URL, "");
        SharedPreferences.Editor e = p.edit();
        if (!url.isEmpty()) {
          try {
            url = ServerUrls.normalize(url);
          } catch (IllegalArgumentException ignored) {
            // 예전 앱이 받아 준 주소다 — 그대로 둔다.
          }
          String id = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
          e.putString(LIST, id)
              .putString(ACTIVE, id)
              .putString(k(id, URL), url)
              .putString(k(id, DEVICE_ID), p.getString(DEVICE_ID, ""))
              .putString(k(id, DEVICE_TOKEN), p.getString(DEVICE_TOKEN, ""))
              .putString(k(id, DEVICE_USER_ID), p.getString(DEVICE_USER_ID, ""))
              .putString(k(id, SESSION_TOKEN), p.getString(SESSION_TOKEN, ""))
              .putBoolean(k(id, VOICE_ENABLED), p.getBoolean(VOICE_ENABLED, false))
              .putBoolean(k(id, VOICE_ASKED), p.getBoolean(VOICE_ASKED, false));
        }
        for (String key : LEGACY) e.remove(key);
        // 디스크에 바로 쓴다 — 옮긴 직후 프로세스가 죽어도 자격을 잃거나 두 번 옮기지 않게.
        e.commit();
      }
      migrated = true;
    }
  }
}
