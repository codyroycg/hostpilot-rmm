package com.hostpilot.rmm;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Registers this phone with the server and turns new alerts / end-user chat messages into notifications. */
final class Notifier {
    private Notifier() {}

    private static final String TAG = "HostPilot";
    static final String CH_ALERTS = "alerts";
    static final String CH_CHAT = "chat";
    static final String CH_ACCOUNT = "account";
    static final String CH_SERVICE = "service";
    static final int JOB_ID = 1;
    static final int ID_SERVICE = 1;
    private static final int ID_ACCOUNT = 2;
    private static final int ID_ALERT_SUMMARY = 3;
    private static final int ID_TEST = 4;

    /** All network work runs on this one thread, so registration and checks never overlap. */
    static final ExecutorService IO = Executors.newSingleThreadExecutor();

    static void ensureChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel alerts = new NotificationChannel(CH_ALERTS, "Alerts", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("New alerts raised by your devices");
        NotificationChannel chat = new NotificationChannel(CH_CHAT, "Chat messages", NotificationManager.IMPORTANCE_HIGH);
        chat.setDescription("Messages from end users through the HostPilot tray icon");
        NotificationChannel account = new NotificationChannel(CH_ACCOUNT, "Sign-in", NotificationManager.IMPORTANCE_DEFAULT);
        account.setDescription("When the app needs you to sign in again");
        NotificationChannel service = new NotificationChannel(CH_SERVICE, "Instant notifications service", NotificationManager.IMPORTANCE_MIN);
        service.setDescription("The small notification shown while instant notifications are on");
        service.setShowBadge(false);
        nm.createNotificationChannels(Arrays.asList(alerts, chat, account, service));
    }

    static Map<String, String> bearer(Prefs p) {
        return Collections.singletonMap("Authorization", "Bearer " + p.token());
    }

    // ---------- registration ----------

    /** Called (on IO) when the console signs in inside the app. Uses the WebView's session cookie once. */
    static void register(Context c, String username) throws IOException, JSONException {
        Prefs p = new Prefs(c);
        String server = p.server();
        if (server.isEmpty() || username == null || username.isEmpty()) return;
        if (!p.token().isEmpty() && username.equals(p.user())) {
            schedule(c);
            return;
        }
        if (!p.token().isEmpty()) unregister(c); // someone else signed in on this phone
        String cookie = CookieManager.getInstance().getCookie(server);
        if (cookie == null || cookie.isEmpty()) return;
        JSONObject body = new JSONObject();
        body.put("name", (Build.MANUFACTURER + " " + Build.MODEL).trim());
        body.put("install_id", p.installId());
        JSONObject r = Api.call("POST", server + "/api/mobile/register",
                Collections.singletonMap("Cookie", cookie), body.toString());
        p.setRegistration(r.getString("token"), username, r.optLong("alerts_after"), r.optLong("chat_after"));
        c.getSystemService(NotificationManager.class).cancel(ID_ACCOUNT);
        schedule(c);
    }

    /** Called (on IO) on sign-out or when changing server. */
    static void unregister(Context c) {
        Prefs p = new Prefs(c);
        if (!p.token().isEmpty() && !p.server().isEmpty()) {
            try {
                Api.call("DELETE", p.server() + "/api/mobile/register", bearer(p), null);
            } catch (IOException e) {
                Log.i(TAG, "unregister: " + e.getMessage());
            }
        }
        p.clearRegistration();
        c.getSystemService(JobScheduler.class).cancel(JOB_ID);
        LiveService.stop(c);
        c.getSystemService(NotificationManager.class).cancelAll();
    }

    /** Background checks: a periodic job (~15 min, Android decides exactly) plus the optional 1-minute service. */
    static void schedule(Context c) {
        Prefs p = new Prefs(c);
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (p.token().isEmpty()) {
            js.cancel(JOB_ID);
            LiveService.stop(c);
            return;
        }
        if (js.getPendingJob(JOB_ID) == null) {
            js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(c, NotifyJob.class))
                    .setPeriodic(15 * 60 * 1000L)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true)
                    .build());
        }
        if (p.instant()) LiveService.start(c);
        else LiveService.stop(c);
    }

    // ---------- checking ----------

    /** Fetches anything new since the last check and posts notifications. Safe to call from any background thread. */
    static synchronized int check(Context c) {
        Prefs p = new Prefs(c);
        String server = p.server();
        if (server.isEmpty() || p.token().isEmpty()) return 0;
        JSONObject r;
        try {
            r = Api.call("GET", server + "/api/mobile/notifications?alerts_after=" + p.alertsAfter()
                    + "&chat_after=" + p.chatAfter(), bearer(p), null);
        } catch (Api.HttpError e) {
            if (e.code == 401) signedOutByServer(c, p);
            return 0;
        } catch (IOException e) {
            Log.i(TAG, "check: " + e.getMessage());
            return 0;
        }
        JSONArray alerts = r.optJSONArray("alerts");
        JSONArray chat = r.optJSONArray("chat");
        int posted = 0;
        if (alerts != null && alerts.length() > 0 && p.notifyAlerts()) posted += postAlerts(c, alerts, r.optInt("open_alerts"));
        if (chat != null && chat.length() > 0 && p.notifyChat()) posted += postChat(c, chat);
        p.setCursors(r.optLong("alerts_after", p.alertsAfter()), r.optLong("chat_after", p.chatAfter()));
        return posted;
    }

    private static void signedOutByServer(Context c, Prefs p) {
        p.clearRegistration();
        c.getSystemService(JobScheduler.class).cancel(JOB_ID);
        LiveService.stop(c);
        post(c, ID_ACCOUNT, new Notification.Builder(c, CH_ACCOUNT)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xff2563eb)
                .setContentTitle("Sign in to HostPilot again")
                .setContentText("This phone stopped getting alert notifications. Open the app and sign in.")
                .setStyle(new Notification.BigTextStyle().bigText("This phone stopped getting alert notifications. Open the app and sign in."))
                .setContentIntent(open(c, ""))
                .setAutoCancel(true)
                .build());
    }

    private static int postAlerts(Context c, JSONArray alerts, int openTotal) {
        if (alerts.length() > 3) {
            List<String> hosts = new ArrayList<>();
            for (int i = 0; i < alerts.length(); i++) {
                String h = alerts.optJSONObject(i).optString("hostname");
                if (!hosts.contains(h)) hosts.add(h);
            }
            String text = String.join(", ", hosts.subList(0, Math.min(5, hosts.size()))) + (hosts.size() > 5 ? "…" : "");
            post(c, ID_ALERT_SUMMARY, base(c, CH_ALERTS, alerts.length() + " new alerts (" + openTotal + " open)", text, "#/alerts")
                    .setCategory(Notification.CATEGORY_ERROR).build());
            return 1;
        }
        for (int i = 0; i < alerts.length(); i++) {
            JSONObject a = alerts.optJSONObject(i);
            String sev = a.optString("severity", "warning");
            String title = a.optString("hostname") + " · " + (sev.isEmpty() ? "Alert" : Character.toUpperCase(sev.charAt(0)) + sev.substring(1));
            post(c, (int) (1000 + a.optLong("id") % 1_000_000), base(c, CH_ALERTS, title, a.optString("message"),
                    "#/devices/" + a.optString("agent_id"))
                    .setWhen(a.optLong("created_at", System.currentTimeMillis()))
                    .setCategory(Notification.CATEGORY_ERROR).build());
        }
        return alerts.length();
    }

    private static int postChat(Context c, JSONArray chat) {
        // one notification per device conversation, showing its newest lines
        Map<String, List<JSONObject>> byAgent = new LinkedHashMap<>();
        for (int i = 0; i < chat.length(); i++) {
            JSONObject m = chat.optJSONObject(i);
            byAgent.computeIfAbsent(m.optString("agent_id"), k -> new ArrayList<>()).add(m);
        }
        for (Map.Entry<String, List<JSONObject>> e : byAgent.entrySet()) {
            List<JSONObject> msgs = e.getValue();
            JSONObject last = msgs.get(msgs.size() - 1);
            String author = last.optString("author");
            String title = last.optString("hostname") + (author.isEmpty() ? "" : " · " + author);
            Notification.Builder b = base(c, CH_CHAT, title, last.optString("body"), "#/devices/" + e.getKey() + "/chat")
                    .setWhen(last.optLong("created_at", System.currentTimeMillis()))
                    .setCategory(Notification.CATEGORY_MESSAGE);
            if (msgs.size() > 1) {
                Notification.InboxStyle inbox = new Notification.InboxStyle().setSummaryText(msgs.size() + " new messages");
                for (JSONObject m : msgs.subList(Math.max(0, msgs.size() - 6), msgs.size())) inbox.addLine(m.optString("body"));
                b.setStyle(inbox);
            }
            post(c, 2_000_000 + (e.getKey().hashCode() & 0xffff), b.build());
        }
        return byAgent.size();
    }

    static void test(Context c) {
        post(c, ID_TEST, base(c, CH_ALERTS, "Test notification", "Alert notifications are working on this phone.", "#/alerts").build());
    }

    // ---------- helpers ----------

    private static Notification.Builder base(Context c, String channel, String title, String text, String path) {
        return new Notification.Builder(c, channel)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xff2563eb)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setShowWhen(true)
                .setAutoCancel(true)
                .setContentIntent(open(c, path));
    }

    /** Opens the app at a console route such as "#/alerts". */
    static PendingIntent open(Context c, String path) {
        Intent i = new Intent(c, MainActivity.class)
                .setAction("open:" + path)
                .putExtra(MainActivity.EXTRA_PATH, path)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, path.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static boolean canNotify(Context c) {
        if (Build.VERSION.SDK_INT >= 33
                && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return c.getSystemService(NotificationManager.class).areNotificationsEnabled();
    }

    private static void post(Context c, int id, Notification n) {
        if (!canNotify(c)) return;
        ensureChannels(c); // the job can run before the app was ever opened after a reboot / update
        c.getSystemService(NotificationManager.class).notify(id, n);
    }
}
