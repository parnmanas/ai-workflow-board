package com.parnmanas.awb;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

/**
 * 서버 하나 = 오리진 하나 — 목록의 중복 판정 · 브릿지 주입 · 토큰을 붙일 곳이 전부 이 오리진으로 갈린다.
 * WebView 가 알려 주는 오리진(소문자 · 기본 포트 생략 · punycode)과 글자 그대로 같아야 한다.
 */
public class ServerUrlsTest {
  @Test
  public void normalizesWhatPeopleType() {
    assertEquals("https://awb.example.com", ServerUrls.normalize("awb.example.com"));
    assertEquals("https://awb.example.com", ServerUrls.normalize("  https://AWB.Example.com/  "));
    assertEquals("http://localhost:7799", ServerUrls.normalize("http://localhost:7799/"));
    assertEquals("http://192.168.0.10:7701", ServerUrls.normalize("http://192.168.0.10:7701"));
    // 기본 포트는 오리진에 없다(WebView 도 그렇게 알려 준다).
    assertEquals("https://awb.example.com", ServerUrls.normalize("https://awb.example.com:443"));
    assertEquals("http://awb.example.com", ServerUrls.normalize("http://awb.example.com:80"));
    assertEquals("https://awb.example.com:8443", ServerUrls.normalize("https://awb.example.com:8443"));
    // 쿼리 · 조각은 버리고 경로는 남긴다.
    assertEquals("https://awb.example.com/awb", ServerUrls.normalize("https://awb.example.com/awb/?x=1#top"));
    // 밑줄이 든 이름 · 국제화 도메인
    assertEquals("http://my_server:7701", ServerUrls.normalize("http://my_server:7701"));
    assertEquals("https://xn--3e0b707e.example", ServerUrls.normalize("https://한국.example"));
    assertEquals("http://[::1]:7701", ServerUrls.normalize("http://[::1]:7701"));
  }

  @Test
  public void rejectsWhatIsNotAServer() {
    assertThrows(IllegalArgumentException.class, () -> ServerUrls.normalize(""));
    assertThrows(IllegalArgumentException.class, () -> ServerUrls.normalize("   "));
    assertThrows(IllegalArgumentException.class, () -> ServerUrls.normalize("ftp://awb.example.com"));
    assertThrows(IllegalArgumentException.class, () -> ServerUrls.normalize("https://awb example.com"));
    assertThrows(IllegalArgumentException.class, () -> ServerUrls.normalize("https://awb.example.com:abc"));
    assertThrows(IllegalArgumentException.class, () -> ServerUrls.normalize("https://awb.example.com:70000"));
  }

  @Test
  public void sameOriginMeansSameServer() {
    assertEquals(ServerUrls.originOf("https://awb.example.com"), ServerUrls.originOf("https://AWB.example.com:443/sessions"));
    assertEquals("http://localhost:7799", ServerUrls.originOf("http://localhost:7799/x"));
    // 포트 · 스킴이 다르면 다른 서버다.
    assertEquals("http://localhost:7798", ServerUrls.originOf("http://localhost:7798"));
    assertEquals("http://awb.example.com", ServerUrls.originOf("http://awb.example.com"));
    assertEquals("", ServerUrls.originOf("not a url"));
    assertEquals("", ServerUrls.originOf("about:blank"));
  }

  @Test
  public void hostLabelIsWhatTheListShowsWithoutAName() {
    assertEquals("awb.example.com", ServerUrls.hostLabel("https://awb.example.com"));
    assertEquals("localhost:7799", ServerUrls.hostLabel("http://localhost:7799"));
  }

  @Test
  public void dropsOnlyTheNamedQueryParamAndKeepsTheRestVerbatim() {
    assertEquals("say=%EC%8B%9C%EC%9E%91", ServerUrls.withoutQueryParam("say=%EC%8B%9C%EC%9E%91&server=abc", "server"));
    assertEquals("a=1&b=x+y", ServerUrls.withoutQueryParam("server=abc&a=1&b=x+y", "server"));
    assertEquals("", ServerUrls.withoutQueryParam("server=abc", "server"));
    assertEquals("servers=1", ServerUrls.withoutQueryParam("servers=1&server", "server"));
    assertEquals("", ServerUrls.withoutQueryParam(null, "server"));
  }
}
