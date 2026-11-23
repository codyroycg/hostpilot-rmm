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
//
// Chat: the agent also publishes ChatToken; the tray long-polls /api/chat/device/poll with it and shows a chat
// window when a technician writes. The token only grants access to this device's conversation.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;
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

    // test hook: HostPilotTray.exe --chat-test <server url> <chat token>  (normally both come from the registry)
    public static string ServerOverride, TokenOverride;

    [STAThread]
    static int Main(string[] args) {
      if (args.Length == 3 && args[0] == "--chat-test") { ServerOverride = args[1]; TokenOverride = args[2]; }
      foreach (string a in args) {
        string s = a.ToLowerInvariant();
        if (s == "/update" || s == "-update" || s == "--update") {
          string err = RequestUpdate();
          Console.WriteLine(err ?? "Update requested. The agent will update within about 30 seconds.");
          return err == null ? 0 : 1;
        }
      }
      bool created;
      // test mode runs alongside a real tray icon, so it uses its own single-instance name
      using (Mutex m = new Mutex(true, ServerOverride != null ? @"Local\HostPilotTrayTest" : @"Local\HostPilotTray", out created)) {
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
    ChatClient chat;
    public Icon AppIcon { get { return icons[(int)AgentState.Connected]; } }
    public void Balloon(string title, string text) { icon.ShowBalloonTip(6000, title, text, ToolTipIcon.Info); }

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
      var chatItem = new ToolStripMenuItem("Chat with IT support...", null, delegate { chat.ShowWindow(false); });
      chatItem.Font = new Font(chatItem.Font, FontStyle.Bold);
      menu.Items.Add(chatItem);
      menu.Items.Add("Update agent now", null, delegate { UpdateNow(); });
      menu.Opening += delegate { Refresh(); };

      icon.ContextMenuStrip = menu;
      icon.DoubleClick += delegate { chat.ShowWindow(false); };
      icon.BalloonTipClicked += delegate { if (chat.Pending) chat.ShowWindow(false); };
      icon.Visible = true;
      chat = new ChatClient(this);
      chat.Start();
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
    internal static string RegS(string name) { object v = Reg(name); return v == null ? "" : v.ToString(); }
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
      if (chat != null) chat.Stop();
      timer.Dispose();
      icon.Visible = false;
      icon.Dispose();
      foreach (Icon i in icons) if (i != null) i.Dispose();
    }
  }

  // ---------- chat with IT support ----------
  // Long-polls the HostPilot server with this device's chat token (published by the agent in the registry).
  sealed class ChatClient {
    readonly TrayApp app;
    readonly SynchronizationContext ui;
    ChatForm form;
    long lastId;
    bool loaded;
    volatile bool stop;
    public bool Pending;
    readonly List<Dictionary<string, object>> history = new List<Dictionary<string, object>>();

    public ChatClient(TrayApp app) { this.app = app; ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext(); }

    static string Server() { return (Program.ServerOverride ?? TrayApp.RegS("Server")).TrimEnd('/'); }
    static string Token() { return Program.TokenOverride ?? TrayApp.RegS("ChatToken"); }

    public void Start() {
      ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
      var t = new Thread(Loop); t.IsBackground = true; t.Start();
    }
    public void Stop() { stop = true; }

    static string Http(string method, string url, string json, int timeoutMs) {
      var req = (HttpWebRequest)WebRequest.Create(url);
      req.Method = method; req.Timeout = timeoutMs; req.ReadWriteTimeout = timeoutMs; req.UserAgent = "HostPilotTray";
      if (json != null) {
        byte[] b = Encoding.UTF8.GetBytes(json);
        req.ContentType = "application/json"; req.ContentLength = b.Length;
        using (var s = req.GetRequestStream()) s.Write(b, 0, b.Length);
      }
      using (var resp = req.GetResponse()) using (var r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) return r.ReadToEnd();
    }

    void Loop() {
      var json = new JavaScriptSerializer();
      while (!stop) {
        string server = Server(), token = Token();
        if (server.Length == 0 || token.Length == 0) { Thread.Sleep(10000); continue; }
        try {
          string url = server + "/api/chat/device/poll?token=" + Uri.EscapeDataString(token) + "&after=" + lastId + "&wait=" + (loaded ? 25 : 0);
          var data = json.Deserialize<Dictionary<string, object>>(Http("GET", url, null, 40000));
          var msgs = data.ContainsKey("messages") ? data["messages"] as System.Collections.ArrayList : null;
          bool incoming = false;
          if (msgs != null) {
            foreach (Dictionary<string, object> m in msgs) {
              long id = Convert.ToInt64(m["id"]);
              if (id <= lastId) continue;
              lastId = id;
              history.Add(m);
              // pop up for technician messages that arrive while we're running, or that were never delivered
              if ((string)m["direction"] == "tech" && (loaded || m["read_at"] == null)) incoming = true;
            }
          }
          loaded = true;
          if (msgs != null && msgs.Count > 0) {
            var copy = new List<Dictionary<string, object>>(history);
            bool pop = incoming;
            ui.Post(delegate { if (form != null && !form.IsDisposed) form.SetHistory(copy); if (pop) Incoming(); }, null);
          }
        } catch (Exception) {
          Thread.Sleep(8000);
        }
      }
    }

    void Incoming() {
      Pending = true;
      ShowWindow(true);
    }

    public void ShowWindow(bool alert) {
      if (form == null || form.IsDisposed) {
        form = new ChatForm(this, app.AppIcon);
        form.SetHistory(new List<Dictionary<string, object>>(history));
      }
      if (!form.Visible) form.Show();
      if (form.WindowState == FormWindowState.Minimized) form.WindowState = FormWindowState.Normal;
      if (alert) { form.Flash(); app.Balloon("Message from IT support", "Your IT team sent you a message."); }
      else { form.Activate(); Pending = false; }
      form.TopMost = true; form.TopMost = false; // bring to front without stealing focus permanently
    }

    // returns null on success or an error message
    public string Send(string text) {
      try {
        var json = new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "author", Environment.UserName }, { "body", text } });
        Http("POST", Server() + "/api/chat/device/send?token=" + Uri.EscapeDataString(Token()), json, 15000);
        return null;
      } catch (Exception e) { return e.Message; }
    }
  }

  sealed class ChatForm : Form {
    readonly ChatClient client;
    readonly RichTextBox log = new RichTextBox();
    readonly TextBox input = new TextBox();
    readonly Button send = new Button();
    readonly Label status = new Label();

    [DllImport("user32.dll")] static extern bool FlashWindow(IntPtr hwnd, bool invert);

    public ChatForm(ChatClient client, Icon icon) {
      this.client = client;
      Text = "IT support chat"; Icon = icon; Width = 420; Height = 520; MinimumSize = new Size(320, 360);
      StartPosition = FormStartPosition.Manual;
      var wa = Screen.PrimaryScreen.WorkingArea;
      Location = new Point(wa.Right - Width - 16, wa.Bottom - Height - 16);
      Font = new Font("Segoe UI", 9.5f);

      var head = new Label { Dock = DockStyle.Top, Height = 34, Text = "  Chat with your IT support team", TextAlign = ContentAlignment.MiddleLeft,
        BackColor = Color.FromArgb(37, 99, 235), ForeColor = Color.White, Font = new Font("Segoe UI", 10.5f, FontStyle.Bold) };
      log.Dock = DockStyle.Fill; log.ReadOnly = true; log.BorderStyle = BorderStyle.None; log.BackColor = Color.White; log.DetectUrls = true;
      log.LinkClicked += (s, e) => { try { System.Diagnostics.Process.Start(e.LinkText); } catch { } };

      var bottom = new Panel { Dock = DockStyle.Bottom, Height = 92, Padding = new Padding(8) };
      input.Multiline = true; input.Dock = DockStyle.Fill; input.ScrollBars = ScrollBars.Vertical;
      send.Text = "Send"; send.Dock = DockStyle.Right; send.Width = 76;
      status.Dock = DockStyle.Bottom; status.Height = 18; status.ForeColor = Color.Gray; status.Font = new Font("Segoe UI", 8f);
      status.Text = "Enter to send, Shift+Enter for a new line";
      bottom.Controls.Add(input); bottom.Controls.Add(send); bottom.Controls.Add(status);
      Controls.Add(log); Controls.Add(bottom); Controls.Add(head);

      send.Click += delegate { DoSend(); };
      input.KeyDown += (s, e) => { if (e.KeyCode == Keys.Enter && !e.Shift) { e.SuppressKeyPress = true; DoSend(); } };
      Activated += delegate { client.Pending = false; };
      Shown += delegate { input.Focus(); };
    }

    public void Flash() { FlashWindow(Handle, true); }

    void DoSend() {
      string text = input.Text.Trim();
      if (text.Length == 0) return;
      send.Enabled = false; status.Text = "Sending...";
      var t = new Thread(() => {
        string err = client.Send(text);
        BeginInvoke((MethodInvoker)delegate {
          send.Enabled = true;
          if (err == null) { input.Clear(); status.Text = "Sent"; }
          else status.Text = "Couldn't send: " + err;
          input.Focus();
        });
      });
      t.IsBackground = true; t.Start();
    }

    public void SetHistory(List<Dictionary<string, object>> msgs) {
      log.Clear();
      if (msgs.Count == 0) { log.SelectionColor = Color.Gray; log.AppendText("No messages yet. Type below to contact your IT team.\n"); return; }
      foreach (var m in msgs) {
        bool tech = (string)m["direction"] == "tech";
        DateTime at = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(Convert.ToDouble(m["created_at"])).ToLocalTime();
        log.SelectionFont = new Font(Font, FontStyle.Bold);
        log.SelectionColor = tech ? Color.FromArgb(37, 99, 235) : Color.FromArgb(22, 101, 52);
        log.AppendText((tech ? "IT support (" + m["author"] + ")" : "You") + "  ");
        log.SelectionFont = new Font(Font, FontStyle.Regular); log.SelectionColor = Color.Gray;
        log.AppendText(at.ToString("t") + "\n");
        log.SelectionColor = Color.Black;
        log.AppendText(m["body"] + "\n\n");
      }
      log.SelectionStart = log.TextLength; log.ScrollToCaret();
    }

    protected override void OnFormClosing(FormClosingEventArgs e) {
      // closing just hides the window; the conversation keeps running in the tray
      if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); }
      base.OnFormClosing(e);
    }
  }
}
