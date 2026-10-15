package com.parnmanas.awb.voice;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import com.parnmanas.awb.AppState;
import com.parnmanas.awb.BuildConfig;
import com.parnmanas.awb.Http;
import com.parnmanas.awb.MainActivity;
import com.parnmanas.awb.Prefs;
import com.parnmanas.awb.R;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * 상시 음성 — 앱 화면이 보이지 않는 동안(다른 앱 · 화면 꺼짐 · 잠금) 듣고, operator 와 대화하고, 답을 읽는다.
 *
 * 웹 화면의 음성 지원과 같은 규칙을 네이티브로 돈다(docs/voice-operator.md "음성 지원 · 잠들기"):
 *   잠듦   — 발화마다 자체 호스팅 STT(`purpose=wake`)로 받아 적고 서버가 부름인지 본다(`operators/match`).
 *   깨어남 — 신호음. 이름 뒤에 이어 한 말, 그다음 말들이 그 operator 세션에 프롬프트로 간다(이름 없이).
 *            답은 SSE 로 받아 서버 TTS 로 읽는다. operator 가 `[[sleep]]` 을 붙이거나 60초 조용하면 잠든다.
 *   알림   — operator 의 보고는 알림음 + 알림, 이어 15초는 이름 없이 듣는다("보고해").
 *
 * 앱 화면이 보이는 동안은 마이크를 놓는다 — 그때는 웹 화면이 같은 일을 한다(AppState).
 * 상태바에 상시 알림이 있고, Android 12+ 는 초록 마이크 표시가 뜬다.
 */
public class VoiceService extends Service implements AppState.Listener, EventStream.Handler {
  public static final String ACTION_START = "com.parnmanas.awb.voice.START";
  public static final String ACTION_STOP = "com.parnmanas.awb.voice.STOP";
  public static final String ACTION_SLEEP = "com.parnmanas.awb.voice.SLEEP";

  private static final String CHANNEL_SERVICE = "awb_voice_service";
  private static final String CHANNEL_ALERT = "awb_voice_alert";
  private static final int NOTIF_SERVICE_ID = 1001;
  private static final int NOTIF_RESUME_ID = 1002;
  private static final long PRESENCE_EVERY_MS = 30_000;
  private static final long OPERATORS_TTL_MS = 5 * 60_000;
  private static final long REPLY_GIVE_UP_MS = 15 * 60_000;
  private static final long MIC_BLOCKED_AFTER_MS = 15_000;
  private static final long BUSY_GIVE_UP_MS = 2 * 60_000;

  public interface StatusListener {
    void onStatus(JSONObject status);
  }

  private static final String TAG = "AWB-Voice";
  private static final CopyOnWriteArrayList<StatusListener> STATUS_LISTENERS = new CopyOnWriteArrayList<>();
  private static volatile VoiceService instance;

  // ─── 바깥에서 부르는 것 ──────────────────────────────────────────────────

  /** 앱이 보이는 동안 부를 것 — 마이크 포그라운드 서비스는 그때만 시작할 수 있다. */
  public static void start(Context c) {
    Intent i = new Intent(c, VoiceService.class).setAction(ACTION_START);
    try {
      c.startForegroundService(i);
    } catch (Exception ignored) {
      // 백그라운드 시작 제한 — 다음에 앱이 보일 때 다시 부른다.
    }
  }

  public static void stop(Context c) {
    VoiceService s = instance;
    if (s != null) s.shutdown();
  }

  public static void addStatusListener(StatusListener l) {
    STATUS_LISTENERS.addIfAbsent(l);
  }

  public static void removeStatusListener(StatusListener l) {
    STATUS_LISTENERS.remove(l);
  }

  public static JSONObject statusJson(Context c) {
    VoiceService s = instance;
    boolean mic = c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    boolean notif = Build.VERSION.SDK_INT < 33
        || c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    return Http.obj(
        "enabled", Prefs.voiceEnabled(c),
        "running", s != null,
        "state", s == null ? "off" : s.stateName(),
        "detail", s == null ? "" : s.detail,
        "operator", s == null || s.awakeOp == null ? "" : s.awakeOp.name,
        "mic", mic,
        "notifications", notif,
        "battery_optimized", MainActivity.isBatteryOptimized(c));
  }

  // ─── 상태 ────────────────────────────────────────────────────────────────

  private enum Mode { SLEEPING, AWAKE }

  private VoiceApi api;
  private Speaker speaker;
  private EventStream events;
  private final VoiceRules.TurnAnswers answers = new VoiceRules.TurnAnswers();
  private ExecutorService worker;
  private ExecutorService speech;
  private ExecutorService fetch;
  private ScheduledExecutorService ticker;
  private PowerManager.WakeLock wakeLock;
  private Thread listenThread;
  private volatile boolean running = false;
  private volatile AudioRecord recorder;

  private volatile Mode mode = Mode.SLEEPING;
  private volatile VoiceApi.Operator awakeOp;
  private volatile boolean wakeNoteSent = false;
  private volatile long lastActivityAt = 0;
  private volatile String pendingTurnId;
  private volatile long pendingSince = 0;
  private volatile long busySince = 0;
  private final ArrayDeque<String> queued = new ArrayDeque<>();
  private volatile VoiceApi.Operator followUpOp;
  private volatile long followUpUntil = 0;
  private volatile VoiceApi.Operator reportTarget;
  private volatile long reportUntil = 0;
  private volatile boolean speaking = false;
  private volatile long speakingEndedAt = 0;
  private volatile boolean micBlocked = false;
  private volatile String detail = "";
  private volatile String error = "";
  private volatile VoiceApi.Config config;
  private volatile List<VoiceApi.Operator> operators = new ArrayList<>();
  private volatile long operatorsAt = 0;
  private long lastPresenceAt = 0;
  private String tabId = "";
  private BroadcastReceiver debugReceiver;

  private String stateName() {
    if (!error.isEmpty()) return "error";
    if (AppState.isForeground()) return "paused";
    return mode == Mode.AWAKE ? "awake" : "sleeping";
  }

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
    String action = intent == null ? ACTION_START : intent.getAction();
    if (ACTION_STOP.equals(action)) {
      Prefs.setVoiceEnabled(this, false);
      shutdown();
      return START_NOT_STICKY;
    }
    if (ACTION_SLEEP.equals(action)) {
      if (worker != null) worker.execute(() -> sleep(true));
      return START_STICKY;
    }
    if (!Prefs.voiceEnabled(this) || Prefs.deviceToken(this).isEmpty()
        || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      stopSelf();
      return START_NOT_STICKY;
    }
    if (!startAsForeground()) {
      // OS 가 다시 띄웠는데 화면 밖이라 마이크를 받을 수 없다 — 사용자가 앱을 한 번 열면 된다.
      postResumeNotice();
      stopSelf();
      return START_NOT_STICKY;
    }
    if (!running) begin();
    else if (micBlocked && AppState.isForeground()) micBlocked = false; // 앱이 열렸다 — 다음 배경 전환에서 다시 연다
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    shutdown();
    super.onDestroy();
  }

  private boolean startAsForeground() {
    Notification n = buildNotification();
    try {
      if (Build.VERSION.SDK_INT >= 30) {
        startForeground(NOTIF_SERVICE_ID, n,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
      } else if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIF_SERVICE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
      } else {
        startForeground(NOTIF_SERVICE_ID, n);
      }
      return true;
    } catch (Exception e) {
      return false;
    }
  }

  private void begin() {
    running = true;
    instance = this;
    api = new VoiceApi(this);
    speaker = new Speaker(this);
    worker = Executors.newSingleThreadExecutor();
    speech = Executors.newSingleThreadExecutor();
    fetch = Executors.newSingleThreadExecutor();
    ticker = Executors.newSingleThreadScheduledExecutor();
    tabId = "android-" + (Prefs.deviceId(this).isEmpty() ? "app" : Prefs.deviceId(this));
    getSystemService(NotificationManager.class).cancel(NOTIF_RESUME_ID);
    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
    if (pm != null) {
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AWB:voice");
      wakeLock.setReferenceCounted(false);
      wakeLock.acquire();
    }
    AppState.addListener(this);
    events = new EventStream(this, this);
    events.start();
    worker.execute(this::refreshSetup);
    ticker.scheduleWithFixedDelay(this::tick, 5, 5, TimeUnit.SECONDS);
    if (!AppState.isForeground()) startListening();
    if (BuildConfig.DEBUG) registerDebugHook();
    publish();
  }

  /**
   * 디버그 빌드 전용 — 에뮬레이터에는 마이크 소리를 넣을 길이 없어서, 발화 하나를 마이크 대신 넣는다.
   * `adb shell am broadcast -a com.parnmanas.awb.DEBUG_UTTERANCE -p com.parnmanas.awb [--es file x.wav]`
   * (file 은 앱 files/ 아래 wav. 없으면 1초짜리 소리). 릴리즈 빌드에는 등록되지 않는다.
   */
  private void registerDebugHook() {
    debugReceiver = new BroadcastReceiver() {
      @Override
      public void onReceive(Context context, Intent intent) {
        String file = intent.getStringExtra("file");
        ExecutorService w = worker;
        if (w == null) return;
        w.execute(() -> {
          byte[] pcm;
          try {
            if (file != null) {
              byte[] wav = Files.readAllBytes(new File(getFilesDir(), file).toPath());
              pcm = Arrays.copyOfRange(wav, 44, wav.length);
            } else {
              pcm = new byte[Vad.SAMPLE_RATE * 2];
              for (int i = 0; i < Vad.SAMPLE_RATE; i++) {
                short v = (short) (Math.sin(2 * Math.PI * 300 * i / (double) Vad.SAMPLE_RATE) * 6000);
                pcm[i * 2] = (byte) (v & 0xff);
                pcm[i * 2 + 1] = (byte) ((v >> 8) & 0xff);
              }
            }
          } catch (Exception e) {
            return;
          }
          onUtterance(pcm);
        });
      }
    };
    registerReceiver(debugReceiver, new IntentFilter("com.parnmanas.awb.DEBUG_UTTERANCE"), Context.RECEIVER_EXPORTED);
  }

  /** 끈다 — 녹음 · 스트림 · 락을 전부 거둔다. 서버에도 이 단말의 음성 지원이 꺼졌다고 알린다. */
  void shutdown() {
    if (!running) {
      stopSelf();
      return;
    }
    running = false;
    instance = null;
    AppState.removeListener(this);
    if (debugReceiver != null) {
      try {
        unregisterReceiver(debugReceiver);
      } catch (Exception ignored) {
      }
      debugReceiver = null;
    }
    stopListening();
    if (events != null) events.stop();
    if (speaker != null) speaker.cancel();
    final VoiceApi a = api;
    final String tab = tabId;
    final boolean awake = mode == Mode.AWAKE;
    final boolean enabled = Prefs.voiceEnabled(this);
    final String deviceId = Prefs.deviceId(this);
    // 마지막 알림은 새 스레드로 — 실행기들은 곧 닫는다.
    new Thread(() -> {
      try {
        if (awake) a.presence(tab, null, false);
        if (!enabled && !deviceId.isEmpty()) a.support("android-" + deviceId, false);
      } catch (Exception ignored) {
      }
    }, "awb-voice-bye").start();
    if (worker != null) worker.shutdownNow();
    if (speech != null) speech.shutdownNow();
    if (fetch != null) fetch.shutdownNow();
    if (ticker != null) ticker.shutdownNow();
    if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    mode = Mode.SLEEPING;
    awakeOp = null;
    try {
      stopForeground(STOP_FOREGROUND_REMOVE);
    } catch (Exception ignored) {
    }
    stopSelf();
    for (StatusListener l : STATUS_LISTENERS) l.onStatus(statusJson(this));
  }

  // ─── 설정 · 주기 작업 ─────────────────────────────────────────────────────

  private void refreshSetup() {
    try {
      config = api.config();
      operators = api.operators();
      operatorsAt = System.currentTimeMillis();
      if (!config.wakeReady) {
        error = config.wakeError.isEmpty() ? "호출어 인식 엔진이 준비되지 않았습니다(Admin → Voice)" : config.wakeError;
      } else if (operators.isEmpty()) {
        error = "등록된 operator 가 없습니다 — 세션 화면에서 operator 로 지정해 주세요";
      } else {
        error = "";
      }
      String deviceId = Prefs.deviceId(this);
      if (!deviceId.isEmpty()) api.support("android-" + deviceId, true);
    } catch (VoiceApi.Unauthorized e) {
      error = "로그인이 필요합니다 — 앱을 열어 다시 로그인해 주세요";
    } catch (Exception e) {
      Log.w(TAG, "setup failed", e);
      error = "서버에 닿지 않습니다 — 다시 시도 중";
    }
    Log.i(TAG, "setup: operators=" + operators.size() + " error=" + error);
    updateNotification();
    publish();
  }

  private void tick() {
    if (!running) return;
    long now = System.currentTimeMillis();
    if (!error.isEmpty() && now - operatorsAt > 30_000) {
      operatorsAt = now;
      worker.execute(this::refreshSetup);
    } else if (now - operatorsAt > OPERATORS_TTL_MS) {
      worker.execute(this::refreshSetup);
    }
    if (mode == Mode.AWAKE) {
      if (pendingTurnId != null && now - pendingSince > REPLY_GIVE_UP_MS) {
        pendingTurnId = null;
      }
      boolean idle = pendingTurnId == null && !speaking && queuedEmpty();
      if (idle && now - lastActivityAt > VoiceRules.WAKE_IDLE_SLEEP_MS) {
        worker.execute(() -> sleep(true));
      } else if (now - lastPresenceAt > PRESENCE_EVERY_MS) {
        lastPresenceAt = now;
        final VoiceApi.Operator op = awakeOp;
        worker.execute(() -> {
          try {
            api.presence(tabId, op, true);
          } catch (Exception ignored) {
          }
        });
      }
    }
  }

  private boolean queuedEmpty() {
    synchronized (queued) {
      return queued.isEmpty();
    }
  }

  private VoiceApi.Operator findOperator(String id) {
    for (VoiceApi.Operator op : operators) if (op.id.equals(id)) return op;
    return null;
  }

  /** match 응답에는 계정이 없다 — 목록에서 찾아 붙인다(없으면 목록을 새로 받는다). */
  private VoiceApi.Operator resolve(VoiceApi.Operator matched) throws Exception {
    VoiceApi.Operator op = findOperator(matched.id);
    if (op == null) {
      operators = api.operators();
      operatorsAt = System.currentTimeMillis();
      op = findOperator(matched.id);
    }
    return op == null ? matched : op;
  }

  // ─── 마이크 ───────────────────────────────────────────────────────────────

  @Override
  public void onForegroundChanged(boolean foreground) {
    if (!running) return;
    if (foreground) {
      stopListening();
    } else {
      micBlocked = false;
      startListening();
    }
    updateNotification();
    publish();
  }

  private synchronized void startListening() {
    if (listenThread != null || !running) return;
    listenThread = new Thread(this::listenLoop, "awb-voice-listen");
    listenThread.start();
  }

  private synchronized void stopListening() {
    Thread t = listenThread;
    listenThread = null;
    AudioRecord r = recorder;
    if (r != null) {
      try {
        r.stop();
      } catch (Exception ignored) {
      }
    }
    if (t != null) {
      t.interrupt();
      try {
        t.join(300);
      } catch (InterruptedException ignored) {
      }
    }
  }

  private void listenLoop() {
    int minBuf = AudioRecord.getMinBufferSize(Vad.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
    AudioRecord r;
    try {
      r = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, Vad.SAMPLE_RATE,
          AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuf * 2, 6400));
    } catch (Exception e) {
      onMicFailed();
      return;
    }
    if (r.getState() != AudioRecord.STATE_INITIALIZED) {
      r.release();
      onMicFailed();
      return;
    }
    recorder = r;
    Vad vad = new Vad(pcm -> {
      ExecutorService w = worker;
      if (w != null && !w.isShutdown()) w.execute(() -> onUtterance(pcm));
    });
    short[] buf = new short[960]; // 60ms
    long silentSince = 0;
    boolean wasSpeaking = false;
    try {
      r.startRecording();
      while (running && Thread.currentThread() == listenThread && !Thread.currentThread().isInterrupted()) {
        int n = r.read(buf, 0, buf.length);
        if (n < 0) break;
        if (n == 0) continue;
        // 화면 밖에서 다시 띄워진 서비스는 마이크 대신 0 만 받는다(Android 의 while-in-use 제한).
        boolean zeros = true;
        for (int i = 0; i < n && zeros; i++) zeros = buf[i] == 0;
        long now = System.currentTimeMillis();
        if (zeros) {
          if (silentSince == 0) silentSince = now;
          if (!micBlocked && now - silentSince > MIC_BLOCKED_AFTER_MS) {
            micBlocked = true;
            updateNotification();
            publish();
          }
        } else {
          silentSince = 0;
          if (micBlocked) {
            micBlocked = false;
            updateNotification();
            publish();
          }
        }
        // 읽는 동안(과 끝난 직후 잠깐)은 듣지 않는다 — 스피커 소리에서 부름을 듣지 않게.
        boolean mute = speaking || now - speakingEndedAt < 350;
        if (mute) {
          wasSpeaking = true;
          continue;
        }
        if (wasSpeaking) {
          vad.reset();
          wasSpeaking = false;
        }
        vad.feed(buf, n);
      }
    } catch (Exception ignored) {
    } finally {
      try {
        r.stop();
      } catch (Exception ignored) {
      }
      r.release();
      if (recorder == r) recorder = null;
    }
  }

  private void onMicFailed() {
    micBlocked = true;
    updateNotification();
    publish();
  }

  // ─── 대화 ────────────────────────────────────────────────────────────────

  private void onUtterance(byte[] pcm) {
    if (!running || AppState.isForeground()) return;
    long now = System.currentTimeMillis();
    byte[] wav = Vad.toWav(pcm, Vad.SAMPLE_RATE);
    try {
      if (mode == Mode.SLEEPING) {
        onSleepingUtterance(wav, now);
      } else {
        onAwakeUtterance(wav, now);
      }
    } catch (VoiceApi.Unauthorized e) {
      error = "로그인이 필요합니다 — 앱을 열어 다시 로그인해 주세요";
      updateNotification();
      publish();
    } catch (Exception e) {
      // 네트워크 · STT 실패 — 이 발화는 버리고 다음 말을 듣는다.
      Log.w(TAG, "utterance dropped", e);
      detail = "";
    }
  }

  private void onSleepingUtterance(byte[] wav, long now) throws Exception {
    VoiceApi.Operator follow = followUpOp != null && now < followUpUntil ? followUpOp : null;
    detail = "확인 중…";
    String text = api.transcribe(wav, true);
    detail = "";
    if (text.isEmpty()) return;
    VoiceApi.Match m = api.match(text);
    Log.i(TAG, "sleeping heard \"" + text + "\" → " + (m.operator == null ? "no call" : "call " + m.operator.name));
    if (m.operator != null) {
      wake(resolve(m.operator), m.rest);
    } else if (follow != null && !VoiceRules.isFiller(text)) {
      wake(follow, text);
    } else if (reportTarget != null && now < reportUntil && VoiceRules.isReportRequest(text)) {
      wake(reportTarget, text);
    }
  }

  private void onAwakeUtterance(byte[] wav, long now) throws Exception {
    VoiceApi.Operator op = awakeOp;
    if (op == null) return;
    String text = api.transcribe(wav, false);
    Log.i(TAG, "awake heard \"" + text + "\"");
    if (text.isEmpty() || VoiceRules.isFiller(text)) return;
    lastActivityAt = System.currentTimeMillis();
    // 깨어 있는 동안 다시 이름을 부르면 이름만 떼고, 다른 operator 를 부르면 그쪽이 깨어난다.
    VoiceApi.Match m = api.match(text);
    if (m.operator != null) {
      if (!m.operator.id.equals(op.id)) {
        wake(resolve(m.operator), m.rest);
        return;
      }
      text = m.rest;
      if (text.isEmpty() || VoiceRules.isFiller(text)) return;
    }
    sendPrompt(text);
  }

  private void wake(VoiceApi.Operator op, String firstText) {
    if (op == null) return;
    Log.i(TAG, "wake " + op.name + (firstText == null || firstText.isEmpty() ? "" : " with \"" + firstText + "\""));
    boolean switching = mode == Mode.AWAKE && awakeOp != null && !awakeOp.id.equals(op.id);
    mode = Mode.AWAKE;
    awakeOp = op;
    wakeNoteSent = false;
    lastActivityAt = System.currentTimeMillis();
    followUpOp = null;
    followUpUntil = 0;
    if (reportTarget != null && reportTarget.id.equals(op.id)) reportTarget = null;
    if (switching) {
      pendingTurnId = null;
      synchronized (queued) {
        queued.clear();
      }
    }
    speech.execute(() -> withSpeaking(() -> speaker.earcon(true)));
    lastPresenceAt = System.currentTimeMillis();
    try {
      api.presence(tabId, op, true);
    } catch (Exception ignored) {
    }
    updateNotification();
    publish();
    if (firstText != null && !firstText.isEmpty() && !VoiceRules.isFiller(firstText)) sendPrompt(firstText);
  }

  private void sleep(boolean earcon) {
    if (mode != Mode.AWAKE) return;
    Log.i(TAG, "sleep");
    mode = Mode.SLEEPING;
    awakeOp = null;
    pendingTurnId = null;
    synchronized (queued) {
      queued.clear();
    }
    if (earcon) speech.execute(() -> withSpeaking(() -> speaker.earcon(false)));
    try {
      api.presence(tabId, null, false);
    } catch (Exception ignored) {
    }
    updateNotification();
    publish();
  }

  /** 답을 기다리는 동안 온 말은 줄을 세운다(웹 대화 모드와 같다). */
  private void sendPrompt(String text) {
    VoiceApi.Operator op = awakeOp;
    if (op == null) return;
    if (pendingTurnId != null) {
      synchronized (queued) {
        queued.add(text);
      }
      return;
    }
    String body = wakeNoteSent ? text : VoiceRules.withWakeNote(text);
    try {
      String turnId = api.prompt(op, body);
      busySince = 0;
      wakeNoteSent = true;
      pendingTurnId = turnId.isEmpty() ? null : turnId;
      pendingSince = System.currentTimeMillis();
      Log.i(TAG, "prompt sent to " + op.name + " turn=" + turnId);
      detail = "답을 기다리는 중";
      updateNotification();
    } catch (VoiceApi.Busy busy) {
      // operator 가 다른 턴(보고 등)을 처리 중 — 잠시 뒤 다시 보낸다. 너무 오래 바쁘면 포기한다.
      long now = System.currentTimeMillis();
      if (busySince == 0) busySince = now;
      if (now - busySince > BUSY_GIVE_UP_MS) {
        busySince = 0;
        synchronized (queued) {
          queued.clear();
        }
        detail = op.name + " 가 다른 일을 하느라 받지 못했습니다";
        updateNotification();
        speech.execute(() -> withSpeaking(() -> speaker.earcon(false)));
        publish();
        return;
      }
      detail = op.name + " 가 다른 일을 마치면 보냅니다";
      updateNotification();
      synchronized (queued) {
        queued.addFirst(text);
      }
      ticker.schedule(() -> worker.execute(this::drainQueue), 3, TimeUnit.SECONDS);
    } catch (Exception e) {
      Log.w(TAG, "prompt failed", e);
      detail = "보내지 못했습니다: " + e.getMessage();
      updateNotification();
      speech.execute(() -> withSpeaking(() -> speaker.earcon(false)));
    }
    publish();
  }

  private void drainQueue() {
    if (mode != Mode.AWAKE || pendingTurnId != null) return;
    String next;
    synchronized (queued) {
      next = queued.pollFirst();
    }
    if (next != null) sendPrompt(next);
  }

  // ─── 서버 이벤트 ──────────────────────────────────────────────────────────

  @Override
  public void onConnected() {
    // 끊긴 사이의 턴 종료는 다시 오지 않는다 — 기다리던 답이 있으면 시간 제한이 거둔다.
  }

  @Override
  public void onEvent(String type, JSONObject data) {
    ExecutorService w = worker;
    if (w == null || w.isShutdown()) return;
    w.execute(() -> {
      if ("agent_session_event".equals(type)) onSessionEvent(data);
      else if ("agent_session_update".equals(type)) onSessionUpdate(data);
      else if ("voice_announcement".equals(type)) onAnnouncement(data);
    });
  }

  private void onSessionEvent(JSONObject data) {
    VoiceApi.Operator op = awakeOp;
    if (op == null || !op.sameSession(data.optString("manager_id"), data.optString("cli"), data.optString("session_id"))) {
      return;
    }
    VoiceRules.TurnAnswers.Finished done = answers.push(data.optJSONObject("event"));
    if (done == null || pendingTurnId == null || !done.turnId.equals(pendingTurnId)) return;
    pendingTurnId = null;
    lastActivityAt = System.currentTimeMillis();
    detail = "";
    Log.i(TAG, "turn finished " + done.turnId + " (" + done.stopReason + "): " + done.answer.length() + " chars");
    if (done.speakable()) {
      VoiceRules.SleepSplit split = VoiceRules.splitSleepMarker(done.answer);
      speech.execute(() -> {
        speakAnswer(split.text);
        lastActivityAt = System.currentTimeMillis();
        if (split.sleep) worker.execute(() -> sleep(true));
      });
    }
    updateNotification();
    drainQueue();
  }

  private void onSessionUpdate(JSONObject data) {
    VoiceApi.Operator op = awakeOp;
    JSONObject session = data.optJSONObject("session");
    if (op == null || session == null || pendingTurnId == null) return;
    if (!op.sameSession(session.optString("manager_id"), session.optString("cli"), session.optString("session_id"))) return;
    if ("turn_failed".equals(data.optString("reason"))) {
      answers.forget(pendingTurnId);
      pendingTurnId = null;
      detail = "operator 가 답하지 못했습니다";
      speech.execute(() -> withSpeaking(() -> speaker.earcon(false)));
      updateNotification();
      drainQueue();
    }
  }

  private void onAnnouncement(JSONObject data) {
    // 앱 화면이 보이면 웹 화면이 알린다.
    if (AppState.isForeground()) return;
    String id = data.optString("id", "");
    String text = data.optString("text", "");
    if (id.isEmpty() || text.isEmpty()) return;
    JSONObject opJson = data.optJSONObject("operator");
    JSONObject target = data.optJSONObject("target");
    String kind = data.optString("kind", "");
    VoiceApi.Operator op = opJson == null ? null : findOperator(opJson.optString("id", ""));
    String who = opJson == null ? "" : opJson.optString("name", "");

    if ("operator_reply".equals(kind)) {
      // 이 단말이 맡은 대화의 답은 이미 읽는다.
      VoiceApi.Operator mine = awakeOp;
      if (mine != null && target != null
          && mine.sameSession(target.optString("manager_id"), target.optString("cli"), target.optString("session_id"))) {
        return;
      }
      if (config != null && !config.ttsReady) return;
      speech.execute(() -> {
        try {
          VoiceApi.Audio a = api.announcementAudio(id);
          withSpeaking(() -> speaker.play(a.bytes, a.contentType));
        } catch (Exception ignored) {
        }
      });
      return;
    }

    postAlert(id, who.isEmpty() ? "AWB" : "🎙 " + who, text, target);
    speech.execute(() -> {
      withSpeaking(() -> speaker.playRaw(R.raw.notify));
      if (op != null && mode == Mode.SLEEPING) {
        // 알림음 뒤 잠깐은 이름 없이 듣는다 — "보고해" 만으로 그 operator 에게 간다.
        followUpOp = op;
        followUpUntil = System.currentTimeMillis() + VoiceRules.NOTIFICATION_FOLLOW_UP_MS;
      }
    });
    if (op != null) {
      reportTarget = op;
      reportUntil = System.currentTimeMillis() + VoiceRules.REPORT_TARGET_MS;
    }
  }

  // ─── 소리 ────────────────────────────────────────────────────────────────

  private interface Sound {
    void run();
  }

  private void withSpeaking(Sound s) {
    speaking = true;
    try {
      s.run();
    } finally {
      speaking = false;
      speakingEndedAt = System.currentTimeMillis();
    }
  }

  /** 서버가 화면용 글을 소리용 덩어리로 나누고(`speakable`, 요약), 덩어리마다 합성해 이어 읽는다. */
  private void speakAnswer(String text) {
    if (text == null || text.trim().isEmpty()) return;
    if (config != null && !config.ttsReady) return;
    speaker.resetCancel();
    try {
      List<String> chunks = api.speakable(text, true);
      Future<VoiceApi.Audio> next = chunks.isEmpty() ? null : fetch.submit(() -> api.speech(chunks.get(0)));
      for (int i = 0; i < chunks.size() && next != null; i++) {
        VoiceApi.Audio audio = next.get(60, TimeUnit.SECONDS);
        final int following = i + 1;
        next = following < chunks.size() ? fetch.submit(() -> api.speech(chunks.get(following))) : null;
        final VoiceApi.Audio play = audio;
        withSpeaking(() -> speaker.play(play.bytes, play.contentType));
        if (speaker.isCancelled()) break;
      }
    } catch (Exception e) {
      Log.w(TAG, "speak failed", e);
      withSpeaking(() -> speaker.earcon(false));
    }
  }

  // ─── 알림 ────────────────────────────────────────────────────────────────

  private void createChannels() {
    NotificationManager nm = getSystemService(NotificationManager.class);
    NotificationChannel service = new NotificationChannel(CHANNEL_SERVICE, "AWB 상시 듣기", NotificationManager.IMPORTANCE_LOW);
    service.setDescription("상시 음성이 켜져 있는 동안의 알림");
    service.setShowBadge(false);
    NotificationChannel alert = new NotificationChannel(CHANNEL_ALERT, "AWB 작업 알림", NotificationManager.IMPORTANCE_HIGH);
    alert.setDescription("operator 의 작업 보고 · 확인 요청");
    alert.setSound(null, null); // 소리는 서비스가 직접 낸다(알림음 + 이어 듣기)
    nm.createNotificationChannel(service);
    nm.createNotificationChannel(alert);
  }

  private String names() {
    StringBuilder sb = new StringBuilder();
    for (VoiceApi.Operator op : operators) {
      if (sb.length() > 0) sb.append(", ");
      sb.append(op.name);
      if (sb.length() > 40) break;
    }
    return sb.toString();
  }

  private Notification buildNotification() {
    String title;
    String text;
    VoiceApi.Operator op = awakeOp;
    if (!error.isEmpty()) {
      title = "AWB 상시 듣기 — 멈춤";
      text = error;
    } else if (AppState.isForeground()) {
      title = "AWB 상시 듣기";
      text = "앱 화면이 음성을 맡고 있습니다";
    } else if (micBlocked) {
      title = "AWB 상시 듣기 — 마이크 없음";
      text = "마이크 소리가 들어오지 않습니다 — 앱을 한 번 열어 주세요";
    } else if (mode == Mode.AWAKE && op != null) {
      title = op.name + " 와 대화 중";
      text = detail.isEmpty() ? "말씀하세요 — 끝내려면 “고마워, 됐어”" : detail;
    } else {
      title = "AWB 듣는 중";
      String n = names();
      text = n.isEmpty() ? "“헤이 <이름>” 하고 부르세요" : "“헤이 " + n + "” 하고 부르세요";
    }
    Notification.Builder b = new Notification.Builder(this, CHANNEL_SERVICE)
        .setSmallIcon(R.drawable.ic_stat_voice)
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(openApp(op == null ? null : op.deepLink()))
        .addAction(new Notification.Action.Builder(null, "끄기", serviceIntent(ACTION_STOP, 1)).build());
    if (mode == Mode.AWAKE) {
      b.addAction(new Notification.Action.Builder(null, "잠재우기", serviceIntent(ACTION_SLEEP, 2)).build());
    }
    if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
    return b.build();
  }

  private void updateNotification() {
    if (!running) return;
    getSystemService(NotificationManager.class).notify(NOTIF_SERVICE_ID, buildNotification());
  }

  private void postAlert(String id, String title, String text, JSONObject target) {
    String link = null;
    if (target != null && "session".equals(target.optString("type"))) {
      link = "awb://sessions/" + Uri.encode(target.optString("manager_id")) + "/"
          + Uri.encode(target.optString("cli")) + "/" + Uri.encode(target.optString("session_id"));
    }
    Notification n = new Notification.Builder(this, CHANNEL_ALERT)
        .setSmallIcon(R.drawable.ic_stat_voice)
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(new Notification.BigTextStyle().bigText(text))
        .setAutoCancel(true)
        .setContentIntent(openApp(link))
        .build();
    getSystemService(NotificationManager.class).notify("awb-alert", id.hashCode(), n);
  }

  private void postResumeNotice() {
    NotificationManager nm = getSystemService(NotificationManager.class);
    createChannels();
    Notification n = new Notification.Builder(this, CHANNEL_ALERT)
        .setSmallIcon(R.drawable.ic_stat_voice)
        .setContentTitle("AWB 상시 듣기가 멈췄습니다")
        .setContentText("탭하면 다시 듣습니다")
        .setAutoCancel(true)
        .setContentIntent(openApp(null))
        .build();
    nm.notify(NOTIF_RESUME_ID, n);
  }

  public static void postResumeNotice(Context c) {
    NotificationManager nm = c.getSystemService(NotificationManager.class);
    nm.createNotificationChannel(new NotificationChannel(CHANNEL_ALERT, "AWB 작업 알림", NotificationManager.IMPORTANCE_HIGH));
    Notification n = new Notification.Builder(c, CHANNEL_ALERT)
        .setSmallIcon(R.drawable.ic_stat_voice)
        .setContentTitle("AWB 상시 듣기를 다시 켜려면 탭하세요")
        .setContentText("휴대폰이 다시 켜졌습니다 — 마이크는 앱을 한 번 연 뒤에 쓸 수 있습니다")
        .setAutoCancel(true)
        .setContentIntent(PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
        .build();
    nm.notify(NOTIF_RESUME_ID, n);
  }

  private PendingIntent openApp(String deepLink) {
    Intent intent = new Intent(this, MainActivity.class);
    if (deepLink != null) {
      intent.setAction(Intent.ACTION_VIEW);
      intent.setData(Uri.parse(deepLink));
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return PendingIntent.getActivity(this, deepLink == null ? 0 : deepLink.hashCode(), intent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private PendingIntent serviceIntent(String action, int code) {
    Intent i = new Intent(this, VoiceService.class).setAction(action);
    return PendingIntent.getService(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private void publish() {
    JSONObject status = statusJson(this);
    for (StatusListener l : STATUS_LISTENERS) l.onStatus(status);
  }
}
