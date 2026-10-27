package com.parnmanas.awb;

import java.net.IDN;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * 서버 주소 다루기 — android.net.Uri 를 쓰지 않아 JVM 단위 테스트로 고정한다(ServerUrlsTest).
 *
 * 서버 하나 = 오리진 하나다. WebView 의 localStorage · 쿠키 · 브릿지 주입이 전부 오리진 단위라, 같은 오리진을
 * 두 서버로 등록하면 두 로그인이 한 저장소를 나눠 쓴다. 그래서 목록은 오리진으로 중복을 막는다.
 */
public final class ServerUrls {
  private ServerUrls() {}

  /** 사용자가 친 주소 → `scheme://host[:port][/path]`(끝 슬래시 없음). 틀렸으면 사람이 읽을 문장으로 IllegalArgumentException. */
  public static String normalize(String raw) {
    String v = raw == null ? "" : raw.trim();
    while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
    if (v.isEmpty()) throw new IllegalArgumentException("서버 주소를 입력해 주세요");
    if (!v.contains("://")) v = "https://" + v;
    Parts p = parse(v);
    if (p == null) throw new IllegalArgumentException("주소가 올바르지 않습니다. 예: https://awb.example.com");
    return p.origin() + p.path;
  }

  /** 주소의 오리진 — WebView 가 알려 주는 오리진과 같은 모양(소문자 · 기본 포트 생략). 못 읽으면 "". */
  public static String originOf(String url) {
    Parts p = parse(url);
    return p == null ? "" : p.origin();
  }

  public static String origin(String scheme, String host, int port) {
    String s = scheme.toLowerCase(Locale.ROOT);
    boolean defaultPort = port < 0 || ("https".equals(s) && port == 443) || ("http".equals(s) && port == 80);
    return s + "://" + host.toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
  }

  /** 목록 · 바로가기에 이름 대신 보일 것 — `host[:port]`. */
  public static String hostLabel(String url) {
    String origin = originOf(url);
    int i = origin.indexOf("://");
    return i < 0 ? url : origin.substring(i + 3);
  }

  /**
   * 인코딩된 쿼리에서 이름이 `name` 인 항목만 뺀다. 나머지는 받은 글자 그대로 둔다(디코드 → 인코드를 거치면
   * `+` · 대소문자 퍼센트 인코딩이 바뀐다). 남는 것이 없으면 "".
   */
  public static String withoutQueryParam(String encodedQuery, String name) {
    if (encodedQuery == null || encodedQuery.isEmpty()) return "";
    StringBuilder out = new StringBuilder();
    for (String part : encodedQuery.split("&")) {
      if (part.isEmpty()) continue;
      int eq = part.indexOf('=');
      String key = eq < 0 ? part : part.substring(0, eq);
      if (key.equals(name)) continue;
      if (out.length() > 0) out.append('&');
      out.append(part);
    }
    return out.toString();
  }

  private static final class Parts {
    final String scheme;
    final String host;
    final int port;
    final String path;

    Parts(String scheme, String host, int port, String path) {
      this.scheme = scheme;
      this.host = host;
      this.port = port;
      this.path = path;
    }

    String origin() {
      return ServerUrls.origin(scheme, host, port);
    }
  }

  private static Parts parse(String url) {
    if (url == null) return null;
    URI u;
    try {
      u = new URI(url.trim());
    } catch (URISyntaxException e) {
      return null;
    }
    String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
    if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
    String host = u.getHost();
    int port = u.getPort();
    if (host == null) {
      // `my_server:7701` 처럼 밑줄이 든 이름은 java.net.URI 가 host 로 읽지 않는다 — authority 를 직접 나눈다.
      String auth = u.getRawAuthority();
      if (auth == null) return null;
      int at = auth.lastIndexOf('@');
      if (at >= 0) auth = auth.substring(at + 1);
      int colon = auth.startsWith("[") ? auth.indexOf(':', Math.max(auth.indexOf(']'), 0)) : auth.lastIndexOf(':');
      if (colon >= 0) {
        try {
          port = Integer.parseInt(auth.substring(colon + 1));
        } catch (NumberFormatException e) {
          return null;
        }
        auth = auth.substring(0, colon);
      }
      host = auth;
    }
    if (host.isEmpty() || port == 0 || port > 65535) return null;
    if (!host.startsWith("[")) {
      try {
        // WebView 는 국제화 도메인을 punycode 로 알려 준다 — 같은 모양으로 둬야 오리진이 맞는다.
        host = IDN.toASCII(host, IDN.ALLOW_UNASSIGNED);
      } catch (IllegalArgumentException e) {
        return null;
      }
      if (host.isEmpty()) return null;
    }
    String path = u.getRawPath() == null ? "" : u.getRawPath();
    while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
    return new Parts(scheme, host.toLowerCase(Locale.ROOT), port, path);
  }
}
