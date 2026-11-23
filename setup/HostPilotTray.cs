// HostPilot tray icon: runs in each user's session (started at logon by the "HostPilotTray" scheduled task).
// Shows whether the agent (running as SYSTEM) is connected, and lets the user ask it to update now.
//
// The agent publishes its state in HKLM\SOFTWARE\HostPilot (readable by all users):
//   State      connected | disconnected
//   Heartbeat  unix ms of the agent's last loop (a stale heartbeat means the agent isn't running)
//   LastContact, Server, Version, Message
// "Update now" signals the event Global\HostPilotUpdateNow, which the agent creates with
// Synchronize|Modify rights for authenticated users.
//
// Command line:  HostPilotTray.exe /update   -> request an agent update and exit (works for any user)
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("HostPilot agent status")]
[assembly: System.Reflection.AssemblyProduct("HostPilot RMM")]

namespace HostPilot {
  enum AgentState { Connected, Disconnected, Stopped, Updating }

  static class Program {
    const string EventName = @"Global\HostPilotUpdateNow";

    [STAThread]
    static int Main(string[] args) {
      foreach (string a in args) {
        string s = a.ToLowerInvariant();
        if (s == "/update" || s == "-update" || s == "--update") {
          string err = RequestUpdate();
          Console.WriteLine(err ?? "Update requested. The agent will update within about 30 seconds.");
          return err == null ? 0 : 1;
        }
      }
      bool created;
      using (Mutex m = new Mutex(true, @"Local\HostPilotTray", out created)) {
        if (!created) return 0; // already running in this session
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (TrayApp app = new TrayApp()) Application.Run();
      }
      return 0;
    }

    /** Signals the agent; returns null on success or an error message. */
    public static string RequestUpdate() {
      try {
        using (EventWaitHandle ev = EventWaitHandle.OpenExisting(EventName,
            System.Security.AccessControl.EventWaitHandleRights.Modify | System.Security.AccessControl.EventWaitHandleRights.Synchronize)) {
          ev.Set();
        }
        return null;
      } catch (WaitHandleCannotBeOpenedException) {
        return "The HostPilot agent isn't running, so it can't be updated right now.";
      } catch (UnauthorizedAccessException) {
        return "Access denied while contacting the HostPilot agent.";
      } catch (Exception e) {
        return "Couldn't contact the HostPilot agent: " + e.Message;
      }
    }
  }

  sealed class TrayApp : IDisposable {
    readonly NotifyIcon icon = new NotifyIcon();
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly ToolStripMenuItem stateItem = new ToolStripMenuItem();
    readonly ToolStripMenuItem serverItem = new ToolStripMenuItem();
    readonly ToolStripMenuItem contactItem = new ToolStripMenuItem();
    readonly ToolStripMenuItem versionItem = new ToolStripMenuItem();
    readonly Icon[] icons = new Icon[4];
    AgentState? shown;
    DateTime updateRequested = DateTime.MinValue;
    string lastVersion;

    public TrayApp() {
      icons[(int)AgentState.Connected] = MakeIcon(Color.FromArgb(34, 197, 94));
      icons[(int)AgentState.Disconnected] = MakeIcon(Color.FromArgb(239, 68, 68));
      icons[(int)AgentState.Stopped] = MakeIcon(Color.FromArgb(148, 163, 184));
      icons[(int)AgentState.Updating] = MakeIcon(Color.FromArgb(56, 189, 248));

      ContextMenuStrip menu = new ContextMenuStrip();
      ToolStripLabel title = new ToolStripLabel("HostPilot agent");
      title.Font = new Font(title.Font, FontStyle.Bold);
      menu.Items.Add(title);
      foreach (ToolStripMenuItem i in new[] { stateItem, serverItem, contactItem, versionItem }) { i.Enabled = false; menu.Items.Add(i); }
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("Update agent now", null, delegate { UpdateNow(); });
      menu.Opening += delegate { Refresh(); };

      icon.ContextMenuStrip = menu;
      icon.DoubleClick += delegate { ShowStatus(); };
      icon.Visible = true;
      timer.Interval = 5000;
      timer.Tick += delegate { Refresh(); };
      timer.Start();
      Refresh();
    }

    static object Reg(string name) {
      try {
        using (RegistryKey k = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64).OpenSubKey(@"SOFTWARE\HostPilot")) {
          return k == null ? null : k.GetValue(name);
        }
      } catch { return null; }
    }
    static string RegS(string name) { object v = Reg(name); return v == null ? "" : v.ToString(); }
    static long RegMs(string name) { long n; return long.TryParse(RegS(name), out n) ? n : 0; }
    static DateTime FromMs(long ms) { return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms).ToLocalTime(); }

    static string Ago(long ms) {
      if (ms <= 0) return "never";
      TimeSpan d = DateTime.Now - FromMs(ms);
      if (d.TotalSeconds < 0) d = TimeSpan.Zero;
      if (d.TotalSeconds < 60) return (int)d.TotalSeconds + "s ago";
      if (d.TotalMinutes < 60) return (int)d.TotalMinutes + " min ago";
      if (d.TotalHours < 48) return (int)d.TotalHours + " h ago";
      return FromMs(ms).ToString("g");
    }

    AgentState Current() {
      long hb = RegMs("Heartbeat");
      bool alive = hb > 0 && (DateTime.Now - FromMs(hb)).TotalSeconds < 120;
      string version = RegS("Version");
      if (updateRequested > DateTime.MinValue) {
        if ((DateTime.Now - updateRequested).TotalSeconds > 120 || (lastVersion != null && version != lastVersion)) updateRequested = DateTime.MinValue;
        else return AgentState.Updating;
      }
      if (!alive) return AgentState.Stopped;
      return RegS("State") == "connected" ? AgentState.Connected : AgentState.Disconnected;
    }

    static string Describe(AgentState s) {
      switch (s) {
        case AgentState.Connected: return "Connected";
        case AgentState.Disconnected: return "Disconnected - can't reach the server";
        case AgentState.Updating: return "Updating...";
        default: return "Agent not running";
      }
    }

    void Refresh() {
      AgentState s = Current();
      string server = RegS("Server");
      string host = server;
      try { host = new Uri(server).Host; } catch { }
      stateItem.Text = "Status: " + Describe(s);
      serverItem.Text = "Server: " + (host.Length > 0 ? host : "unknown");
      contactItem.Text = "Last contact: " + Ago(RegMs("LastContact"));
      string v = RegS("Version");
      versionItem.Text = "Agent version: " + (v.Length > 0 ? v : "unknown");
      string tip = "HostPilot: " + Describe(s);
      icon.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip; // NotifyIcon limit
      if (shown != s) {
        icon.Icon = icons[(int)s];
        if (shown == AgentState.Updating && s == AgentState.Connected)
          icon.ShowBalloonTip(4000, "HostPilot", "The agent was updated and is connected.", ToolTipIcon.Info);
        shown = s;
      }
    }

    void ShowStatus() {
      Refresh();
      string msg = RegS("Message");
      icon.ShowBalloonTip(6000, "HostPilot agent", stateItem.Text.Replace("Status: ", "") + "\n" + serverItem.Text + "\n" + contactItem.Text +
        (Current() == AgentState.Disconnected && msg.Length > 0 ? "\n" + (msg.Length > 120 ? msg.Substring(0, 120) : msg) : ""), ToolTipIcon.None);
    }

    void UpdateNow() {
      string err = Program.RequestUpdate();
      if (err != null) { icon.ShowBalloonTip(5000, "HostPilot", err, ToolTipIcon.Warning); return; }
      lastVersion = RegS("Version");
      updateRequested = DateTime.Now;
      Refresh();
      icon.ShowBalloonTip(5000, "HostPilot", "Update requested. The agent will download the latest version and restart within about 30 seconds.", ToolTipIcon.Info);
    }

    // Blue rounded square with a white "H" and a status dot in the corner.
    static Icon MakeIcon(Color dot) {
      using (Bitmap bmp = new Bitmap(32, 32)) {
        using (Graphics g = Graphics.FromImage(bmp)) {
          g.SmoothingMode = SmoothingMode.AntiAlias;
          g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
          using (GraphicsPath p = Rounded(new Rectangle(1, 1, 27, 27), 7))
          using (Brush b = new SolidBrush(Color.FromArgb(37, 99, 235))) g.FillPath(b, p);
          using (Font f = new Font("Segoe UI", 15f, FontStyle.Bold, GraphicsUnit.Pixel))
          using (StringFormat sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            g.DrawString("H", f, Brushes.White, new RectangleF(1, 0, 27, 28), sf);
          using (Brush b = new SolidBrush(dot)) g.FillEllipse(b, 17, 17, 14, 14);
          using (Pen pen = new Pen(Color.White, 2f)) g.DrawEllipse(pen, 17, 17, 14, 14);
        }
        IntPtr h = bmp.GetHicon();
        Icon tmp = Icon.FromHandle(h);
        Icon copy = (Icon)tmp.Clone();
        DestroyIcon(h);
        return copy;
      }
    }

    static GraphicsPath Rounded(Rectangle r, int rad) {
      GraphicsPath p = new GraphicsPath();
      int d = rad * 2;
      p.AddArc(r.X, r.Y, d, d, 180, 90);
      p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
      p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
      p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
      p.CloseFigure();
      return p;
    }

    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);

    public void Dispose() {
      timer.Dispose();
      icon.Visible = false;
      icon.Dispose();
      foreach (Icon i in icons) if (i != null) i.Dispose();
    }
  }
}
