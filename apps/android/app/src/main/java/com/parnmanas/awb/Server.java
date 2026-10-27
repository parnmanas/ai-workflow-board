package com.parnmanas.awb;

/**
 * 등록된 AWB 서버 하나의 스냅샷 — 읽은 순간의 값이다. 토큰은 다른 스레드가 바꾸므로 오래 들고 있지 말고
 * 필요할 때 {@link Servers#get} 으로 다시 읽는다(Auth · 음성 서비스는 id 만 들고 다닌다).
 */
public final class Server {
  public final String id;
  public final String url;
  /** 사용자가 붙인 이름. 비었으면 {@link #label()} 이 host 를 보인다. */
  public final String name;
  public final String deviceId;
  public final String deviceToken;
  public final String deviceUserId;
  /** 그 서버에 로그인한 사람(이름 · 이메일) — 목록에 보인다. */
  public final String userLabel;
  public final String sessionToken;
  /** 상시 음성 — 단말 스위치지만 서버마다 따로 둔다(서버도 단말별 음성 지원 상태를 서버마다 따로 안다). */
  public final boolean voiceEnabled;
  public final boolean voiceAsked;

  Server(String id, String url, String name, String deviceId, String deviceToken, String deviceUserId,
      String userLabel, String sessionToken, boolean voiceEnabled, boolean voiceAsked) {
    this.id = id;
    this.url = url;
    this.name = name;
    this.deviceId = deviceId;
    this.deviceToken = deviceToken;
    this.deviceUserId = deviceUserId;
    this.userLabel = userLabel;
    this.sessionToken = sessionToken;
    this.voiceEnabled = voiceEnabled;
    this.voiceAsked = voiceAsked;
  }

  public String origin() {
    return ServerUrls.originOf(url);
  }

  public String label() {
    return name.isEmpty() ? ServerUrls.hostLabel(url) : name;
  }

  /** 다시 로그인하지 않고 이 서버를 쓸 수 있는가(단말 자격 · 세션 중 하나라도 있다). */
  public boolean signedIn() {
    return !deviceToken.isEmpty() || !sessionToken.isEmpty();
  }
}
