package com.hostpilot.rmm;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.UUID;

/** App settings and the phone's notification registration. */
final class Prefs {
    private final SharedPreferences p;

    Prefs(Context c) {
        p = c.getApplicationContext().getSharedPreferences("hostpilot", Context.MODE_PRIVATE);
    }

    String server() { return p.getString("server", ""); }
    void setServer(String s) { p.edit().putString("server", s).commit(); }

    // notification token from POST /api/mobile/register (read-only access to the notification feed)
    String token() { return p.getString("token", ""); }
    String user() { return p.getString("user", ""); }

    void setRegistration(String token, String user, long alertsAfter, long chatAfter) {
        p.edit().putString("token", token).putString("user", user)
                .putLong("alerts_after", alertsAfter).putLong("chat_after", chatAfter).commit();
    }

    void clearRegistration() {
        p.edit().remove("token").remove("user").remove("alerts_after").remove("chat_after").commit();
    }

    long alertsAfter() { return p.getLong("alerts_after", 0); }
    long chatAfter() { return p.getLong("chat_after", 0); }

    void setCursors(long alertsAfter, long chatAfter) {
        p.edit().putLong("alerts_after", alertsAfter).putLong("chat_after", chatAfter).commit();
    }

    boolean notifyAlerts() { return p.getBoolean("notify_alerts", true); }
    void setNotifyAlerts(boolean v) { p.edit().putBoolean("notify_alerts", v).apply(); }

    boolean notifyChat() { return p.getBoolean("notify_chat", true); }
    void setNotifyChat(boolean v) { p.edit().putBoolean("notify_chat", v).apply(); }

    /** Check every minute from a foreground service instead of roughly every 15 minutes. */
    boolean instant() { return p.getBoolean("instant", false); }
    void setInstant(boolean v) { p.edit().putBoolean("instant", v).commit(); }

    boolean askedNotifications() { return p.getBoolean("asked_notifications", false); }
    void setAskedNotifications() { p.edit().putBoolean("asked_notifications", true).apply(); }

    /** Stable id for this install, so signing in again replaces this phone's old token. */
    String installId() {
        String id = p.getString("install_id", "");
        if (id.isEmpty()) {
            id = UUID.randomUUID().toString();
            p.edit().putString("install_id", id).commit();
        }
        return id;
    }
}
