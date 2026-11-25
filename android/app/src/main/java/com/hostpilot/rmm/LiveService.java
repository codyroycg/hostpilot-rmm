package com.hostpilot.rmm;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/** Optional "instant notifications": checks every minute while showing a silent ongoing notification. */
public class LiveService extends Service {
    private static final long INTERVAL_MS = 60_000;
    private Thread loop;
    private volatile boolean running;

    static void start(Context c) {
        try {
            c.startForegroundService(new Intent(c, LiveService.class));
        } catch (RuntimeException e) {
            // Android refuses to start foreground services from the background; the periodic job still runs.
            Log.i("HostPilot", "instant notifications not started: " + e.getMessage());
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, LiveService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Prefs p = new Prefs(this);
        Notifier.ensureChannels(this);
        String host = Uri.parse(p.server()).getHost();
        Notification n = new Notification.Builder(this, Notifier.CH_SERVICE)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xff2563eb)
                .setContentTitle("Watching for alerts and messages")
                .setContentText(host == null ? "" : host)
                .setContentIntent(Notifier.open(this, ""))
                .setOngoing(true)
                .build();
        // must come first: a service started with startForegroundService() has to call this within seconds
        if (Build.VERSION.SDK_INT >= 29) startForeground(Notifier.ID_SERVICE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(Notifier.ID_SERVICE, n);

        if (!p.instant() || p.token().isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (loop == null) {
            running = true;
            loop = new Thread(this::run, "hostpilot-live");
            loop.start();
        }
        return START_STICKY;
    }

    private void run() {
        Prefs p = new Prefs(this);
        while (running) {
            Notifier.check(getApplicationContext());
            if (p.token().isEmpty() || !p.instant()) {
                stopSelf();
                return;
            }
            try {
                Thread.sleep(INTERVAL_MS);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        if (loop != null) loop.interrupt();
        loop = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
