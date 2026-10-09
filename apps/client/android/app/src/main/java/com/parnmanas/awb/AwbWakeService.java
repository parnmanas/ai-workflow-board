package com.parnmanas.awb;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 백그라운드 이름 부르기 — Android 포그라운드 서비스.
 *
 * 웹 탭의 상시 청취(WakeListener)가 닿지 않는 곳(다른 앱 앞·화면 꺼짐)에서 듣는다.
 * 흐름: 마이크 → AwbVad 분할 → 서버 transcribe → 서버 wake-match → operator 알림.
 * 판정은 전부 서버라 네이티브는 파이프다. 화면·세션·대화는 WebView(기존 React)가 맡는다.
 *
 * 켜져 있는 동안: 상태바에 상시 알림 + 초록 마이크 표시(Android 12+) + 부분 웨이크락.
 * 배터리는 쓴다 — 꽂아 두는 거치 단말이 전제다. 끄면 스레드·녹음·락을 전부 거둔다.
 */
public class AwbWakeService extends Service {
  public static final String ACTION_START = "com.parnmanas.awb.wake.START";
  public static final String ACTION_STOP = "com.parnmanas.awb.wake.STOP";
  public static final String EXTRA_SERVER_URL = "server_url";
  public static final String EXTRA_TOKEN = "token";

  static final String PREFS = "awb_wake_prefs";
  static final String PREF_ENABLED = "enabled";
  static final String PREF_SERVER_URL = "server_url";
  static final String PREF_TOKEN = "token";

  private static final String CHANNEL_SERVICE = "awb_wake_service";
  private static final String CHANNEL_ALERT = "awb_wake_alert";
  private static final int NOTIF_SERVICE_ID = 1001;

  private static final AtomicBoolean RUNNING = new AtomicBoolean(false);

  public static boolean isRunning() {
    return RUNNING.get();
  }

  private Thread listenThread;
  private final AtomicBoolean stopFlag = new AtomicBoolean(false);
  private AudioRecord recorder;
  private PowerManager.WakeLock wakeLock;
  private ExecutorService uploadPool;
  private String serverUrl = "";
  private String token = "";

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    createChannels();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && ACTION_STOP.equals(intent.getAction())) {
      stopListening();
      return START_NOT_STICKY;
    }
    if (intent != null && intent.hasExtra(EXTRA_SERVER_URL)) {
      serverUrl = intent.getStringExtra(EXTRA_SERVER_URL);
      token = intent.getStringExtra(EXTRA_TOKEN);
      if (serverUrl == null) serverUrl = "";
      if (token == null) token = "";
      savePrefs(serverUrl, token);
    } else {
      SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
      serverUrl = prefs.getString(PREF_SERVER_URL, "");
      token = prefs.getString(PREF_TOKEN, "");
    }
    if (serverUrl == null || serverUrl.isEmpty() || token == null || token.isEmpty()) {
      stopSelf();
      return START_NOT_STICKY;
    }
    if (ActivityCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      stopSelf();
      return START_NOT_STICKY;
    }
    if (RUNNING.compareAndSet(false, true)) {
      startAsForeground();
      startListening();
    }
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    stopListening();
    super.onDestroy();
  }

  private void savePrefs(String url, String tok) {
    getSharedPreferences(PREFS, MODE_PRIVATE)
        .edit()
        .putBoolean(PREF_ENABLED, true)
        .putString(PREF_SERVER_URL, url)
        .putString(PREF_TOKEN, tok)
        .apply();
  }

  private void startAsForeground() {
    Notification notif = new NotificationCompat.Builder(this, CHANNEL_SERVICE)
        .setSmallIcon(android.R.drawable.presence_audio_online)
        .setContentTitle("AWB 듣는 중")
        .setContentText("“헤이 <이름>” 하면 깨어납니다 — 끄려면 앱 설정에서")
        .setContentIntent(openApp(null))
        .setOngoing(true)
        .build();
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIF_SERVICE_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
    } else {
      startForeground(NOTIF_SERVICE_ID, notif);
    }
  }

  private void startListening() {
    stopFlag.set(false);
    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
    if (pm != null) {
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AWB:wake-listen");
      wakeLock.setReferenceCounted(false);
      try {
        wakeLock.acquire(12 * 60 * 60 * 1000L);
      } catch (SecurityException ignored) {
        wakeLock = null;
      }
    }
    uploadPool = Executors.newSingleThreadExecutor();
    listenThread = new Thread(this::listenLoop, "awb-wake-listen");
    listenThread.start();
  }

  private void stopListening() {
    stopFlag.set(true);
    Thread t = listenThread;
    listenThread = null;
    if (t != null) {
      t.interrupt();
      try {
        t.join(2000);
      } catch (InterruptedException ignored) {
      }
    }
    if (recorder != null) {
      try {
        recorder.stop();
      } catch (Exception ignored) {
      }
      try {
        recorder.release();
      } catch (Exception ignored) {
      }
      recorder = null;
    }
    if (uploadPool != null) {
      uploadPool.shutdownNow();
      uploadPool = null;
    }
    if (wakeLock != null && wakeLock.isHeld()) {
      try {
        wakeLock.release();
      } catch (Exception ignored) {
      }
      wakeLock = null;
    }
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(PREF_ENABLED, false).apply();
    RUNNING.set(false);
    try {
      stopForeground(STOP_FOREGROUND_REMOVE);
    } catch (Exception ignored) {
      stopForeground(true);
    }
    stopSelf();
  }

  private void listenLoop() {
    int minBuf = AudioRecord.getMinBufferSize(
        AwbVad.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
    if (minBuf <= 0) return;
    try {
      recorder = new AudioRecord(
          MediaRecorder.AudioSource.MIC,
          AwbVad.SAMPLE_RATE,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          minBuf * 2);
    } catch (Exception e) {
      return;
    }
    if (recorder.getState() != AudioRecord.STATE_INITIALIZED) return;
    AwbVad vad = new AwbVad(pcm -> {
      ExecutorService pool = uploadPool;
      if (pool != null && !pool.isShutdown()) {
        pool.execute(() -> handleUtterance(pcm));
      }
    });
    short[] buf = new short[960]; // 60ms씩 읽기
    try {
      recorder.startRecording();
    } catch (Exception e) {
      return;
    }
    while (!stopFlag.get() && !Thread.currentThread().isInterrupted()) {
      int n;
      try {
        n = recorder.read(buf, 0, buf.length);
      } catch (Exception e) {
        break;
      }
      if (n > 0) {
        vad.feed(buf, n);
      } else if (n < 0) {
        break;
      }
    }
  }

  private void handleUtterance(byte[] pcm) {
    if (stopFlag.get()) return;
    String base = serverUrl;
    String tok = token;
    try {
      byte[] wav = AwbWakeApi.toWav(pcm, AwbVad.SAMPLE_RATE);
      String text = AwbWakeApi.transcribe(base, tok, wav);
      if (text == null || text.isEmpty()) return;
      AwbWakeApi.WakeMatch match = AwbWakeApi.wakeMatch(base, tok, text);
      if (match != null && match.matched) {
        notifyWake(match);
      }
    } catch (Exception ignored) {
      // 네트워크·401·STT 실패는 조용히 넘긴다 — 다음 발화에서 다시 듣는다.
      // 토큰이 바뀌었으면 앱에서 토글을 다시 켤 때 새 토큰이 저장된다.
    }
  }

  private void notifyWake(AwbWakeApi.WakeMatch match) {
    String deepLink = "awb://sessions/"
        + Uri.encode(match.managerId) + "/"
        + Uri.encode(match.cli) + "/"
        + Uri.encode(match.sessionId)
        + "?say=" + Uri.encode(match.rest == null ? "" : match.rest);
    String title = (match.name == null || match.name.isEmpty() ? "Operator" : match.name) + " 깨어남";
    String body = (match.rest == null || match.rest.isEmpty()) ? "탭하여 세션 열기" : match.rest;
    Notification notif = new NotificationCompat.Builder(this, CHANNEL_ALERT)
        .setSmallIcon(android.R.drawable.presence_audio_online)
        .setContentTitle(title)
        .setContentText(body)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setAutoCancel(true)
        .setContentIntent(openApp(deepLink))
        .setFullScreenIntent(openApp(deepLink), true)
        .build();
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm != null) {
      nm.notify("awb-wake", match.sessionId == null ? 0 : match.sessionId.hashCode(), notif);
    }
  }

  private PendingIntent openApp(String deepLink) {
    Intent intent = new Intent(this, MainActivity.class);
    intent.setAction(Intent.ACTION_VIEW);
    if (deepLink != null) {
      intent.setData(Uri.parse(deepLink));
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= 23) {
      flags |= PendingIntent.FLAG_IMMUTABLE;
    }
    return PendingIntent.getActivity(this, deepLink == null ? 0 : deepLink.hashCode(), intent, flags);
  }

  private void createChannels() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    NotificationChannel service = new NotificationChannel(
        CHANNEL_SERVICE, "AWB 듣기", NotificationManager.IMPORTANCE_LOW);
    service.setDescription("백그라운드 이름 부르기가 켜져 있을 때의 상시 알림");
    NotificationChannel alert = new NotificationChannel(
        CHANNEL_ALERT, "AWB 깨어남", NotificationManager.IMPORTANCE_HIGH);
    alert.setDescription("“헤이 <이름>” 을 알아들었을 때의 알림");
    nm.createNotificationChannel(service);
    nm.createNotificationChannel(alert);
  }
}
