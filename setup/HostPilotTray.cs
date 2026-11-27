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
    TicketClient tickets;
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
      menu.Items.Add("Open a support ticket...", null, delegate { tickets.ShowNew(); });
      menu.Items.Add("My support tickets...", null, delegate { tickets.ShowList(0); });
      menu.Items.Add("Update agent now", null, delegate { UpdateNow(); });
      menu.Opening += delegate { Refresh(); };

      icon.ContextMenuStrip = menu;
      icon.DoubleClick += delegate { chat.ShowWindow(false); };
      icon.BalloonTipClicked += delegate {
        if (chat.Pending) chat.ShowWindow(false);
        else if (tickets.PendingTicket > 0) tickets.ShowList(tickets.PendingTicket);
      };
      icon.Visible = true;
      chat = new ChatClient(this);
      chat.Start();
      tickets = new TicketClient(this);
      tickets.Start();
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
      if (tickets != null) tickets.Stop();
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

    internal static string Server() { return (Program.ServerOverride ?? TrayApp.RegS("Server")).TrimEnd('/'); }
    internal static string Token() { return Program.TokenOverride ?? TrayApp.RegS("ChatToken"); }

    public void Start() {
      ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
      var t = new Thread(Loop); t.IsBackground = true; t.Start();
    }
    public void Stop() { stop = true; }

    internal static string Http(string method, string url, string json, int timeoutMs) {
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

  // ---------- support tickets ----------
  // Uses the same per-device chat token: open a ticket for this computer, follow this computer's tickets and reply.
  // Polls every minute and shows a notification when IT support replies.
  sealed class TicketClient {
    readonly TrayApp app;
    readonly SynchronizationContext ui;
    readonly Dictionary<long, long> seen = new Dictionary<long, long>(); // ticket id -> newest IT reply id already seen
    bool loaded;
    volatile bool stop;
    public long PendingTicket;
    NewTicketForm newForm;
    TicketsForm listForm;

    public TicketClient(TrayApp app) { this.app = app; ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext(); }
    public void Start() { var t = new Thread(Loop); t.IsBackground = true; t.Start(); }
    public void Stop() { stop = true; }

    static string Url(string path) { return ChatClient.Server() + path + (path.Contains("?") ? "&" : "?") + "token=" + Uri.EscapeDataString(ChatClient.Token()); }

    /** The server's own error text ("Describe the problem") instead of "(400) Bad Request". */
    public static string ErrorText(Exception e) {
      var we = e as WebException;
      if (we != null && we.Response != null) {
        try {
          using (var r = new StreamReader(we.Response.GetResponseStream(), Encoding.UTF8)) {
            var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(r.ReadToEnd());
            if (d != null && d.ContainsKey("error")) return Convert.ToString(d["error"]);
          }
        } catch { }
      }
      return e.Message;
    }

    public System.Collections.ArrayList Fetch() {
      return new JavaScriptSerializer().Deserialize<System.Collections.ArrayList>(ChatClient.Http("GET", Url("/api/chat/device/tickets"), null, 20000));
    }

    void Loop() {
      while (!stop) {
        if (ChatClient.Server().Length == 0 || ChatClient.Token().Length == 0) { Thread.Sleep(15000); continue; }
        try {
          var list = Fetch();
          long notify = 0; string subject = null;
          foreach (Dictionary<string, object> t in list) {
            long id = Convert.ToInt64(t["id"]);
            long newest = 0;
            foreach (Dictionary<string, object> m in (System.Collections.ArrayList)t["thread"])
              if (Convert.ToBoolean(m["tech"])) newest = Math.Max(newest, Convert.ToInt64(m["id"]));
            lock (seen) {
              long old;
              bool had = seen.TryGetValue(id, out old);
              if (loaded && newest > 0 && (!had || newest > old)) { notify = id; subject = Convert.ToString(t["subject"]); }
              seen[id] = Math.Max(newest, had ? old : 0);
            }
          }
          loaded = true;
          if (notify > 0) {
            long n = notify; string s = subject;
            ui.Post(delegate {
              PendingTicket = n;
              app.Balloon("IT support replied", "Ticket #" + n + ": " + (s.Length > 80 ? s.Substring(0, 80) + "..." : s) + "\nClick to read the reply.");
              if (listForm != null && !listForm.IsDisposed && listForm.Visible) listForm.Reload(n);
            }, null);
          }
        } catch { }
        for (int i = 0; i < 60 && !stop; i++) Thread.Sleep(1000);
      }
    }

    public void MarkSeen(long id, long newestTech) { lock (seen) seen[id] = Math.Max(newestTech, seen.ContainsKey(id) ? seen[id] : 0); }

    public void ShowNew() {
      if (newForm == null || newForm.IsDisposed) newForm = new NewTicketForm(this, app.AppIcon);
      if (!newForm.Visible) newForm.Show();
      if (newForm.WindowState == FormWindowState.Minimized) newForm.WindowState = FormWindowState.Normal;
      newForm.Activate();
    }

    public void ShowList(long select) {
      PendingTicket = 0;
      if (listForm == null || listForm.IsDisposed) listForm = new TicketsForm(this, app.AppIcon);
      if (!listForm.Visible) listForm.Show();
      if (listForm.WindowState == FormWindowState.Minimized) listForm.WindowState = FormWindowState.Normal;
      listForm.Activate();
      listForm.Reload(select);
    }

    // both return null on success or an error message; created gets the new ticket's number
    public string Create(string subject, string body, bool urgent, out long created) {
      created = 0;
      try {
        var json = new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "author", Environment.UserName }, { "subject", subject }, { "body", body }, { "urgent", urgent } });
        var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(ChatClient.Http("POST", Url("/api/chat/device/ticket"), json, 20000));
        created = Convert.ToInt64(d["id"]);
        lock (seen) seen[created] = 0;
        return null;
      } catch (Exception e) { return ErrorText(e); }
    }
    public string Reply(long id, string body) {
      try {
        var json = new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "author", Environment.UserName }, { "body", body } });
        ChatClient.Http("POST", Url("/api/chat/device/tickets/" + id + "/reply"), json, 20000);
        return null;
      } catch (Exception e) { return ErrorText(e); }
    }
    public void Created(long id) {
      app.Balloon("Ticket #" + id + " sent", "Your IT team has your request. You'll get a notification here when they reply.");
    }
  }

  sealed class NewTicketForm : Form {
    readonly TicketClient client;
    readonly TextBox subject = new TextBox();
    readonly TextBox body = new TextBox();
    readonly CheckBox urgent = new CheckBox();
    readonly Button send = new Button();
    readonly Label status = new Label();

    public NewTicketForm(TicketClient client, Icon icon) {
      this.client = client;
      Text = "Open a support ticket"; Icon = icon; Width = 480; Height = 470; MinimumSize = new Size(380, 400);
      StartPosition = FormStartPosition.CenterScreen; Font = new Font("Segoe UI", 9.5f);
      var head = new Label { Dock = DockStyle.Top, Height = 34, Text = "  Ask your IT support team for help", TextAlign = ContentAlignment.MiddleLeft,
        BackColor = Color.FromArgb(37, 99, 235), ForeColor = Color.White, Font = new Font("Segoe UI", 10.5f, FontStyle.Bold) };
      var grid = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(12), ColumnCount = 1, RowCount = 6 };
      grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
      grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
      grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
      grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
      grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
      grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
      grid.Controls.Add(new Label { Text = "What do you need help with?", AutoSize = true, Margin = new Padding(0, 0, 0, 4) });
      subject.Dock = DockStyle.Fill; subject.MaxLength = 200; subject.Margin = new Padding(0, 0, 0, 10);
      grid.Controls.Add(subject);
      grid.Controls.Add(new Label { Text = "Describe the problem (what happens, since when, any error message):", AutoSize = true, Margin = new Padding(0, 0, 0, 4) });
      body.Multiline = true; body.ScrollBars = ScrollBars.Vertical; body.Dock = DockStyle.Fill; body.MaxLength = 20000;
      grid.Controls.Add(body);
      urgent.Text = "It's urgent: I can't work"; urgent.AutoSize = true; urgent.Margin = new Padding(0, 8, 0, 0);
      grid.Controls.Add(urgent);
      var row = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Margin = new Padding(0, 8, 0, 0) };
      send.Text = "Send ticket"; send.AutoSize = true; send.Padding = new Padding(8, 2, 8, 2);
      var cancel = new Button { Text = "Cancel", AutoSize = true };
      status.AutoSize = true; status.ForeColor = Color.Firebrick; status.Margin = new Padding(0, 8, 10, 0);
      row.Controls.Add(send); row.Controls.Add(cancel); row.Controls.Add(status);
      grid.Controls.Add(row);
      Controls.Add(grid); Controls.Add(head);
      AcceptButton = null;
      send.Click += delegate { DoSend(); };
      cancel.Click += delegate { Hide(); };
      Shown += delegate { subject.Focus(); };
    }

    void DoSend() {
      string s = subject.Text.Trim(), b = body.Text.Trim();
      if (s.Length == 0) { status.Text = "Write a short subject."; subject.Focus(); return; }
      if (b.Length == 0) { status.Text = "Describe the problem."; body.Focus(); return; }
      bool u = urgent.Checked;
      send.Enabled = false; status.ForeColor = Color.Gray; status.Text = "Sending...";
      var t = new Thread(() => {
        long id;
        string err = client.Create(s, b, u, out id);
        BeginInvoke((MethodInvoker)delegate {
          send.Enabled = true;
          if (err != null) { status.ForeColor = Color.Firebrick; status.Text = "Couldn't send: " + err; return; }
          subject.Clear(); body.Clear(); urgent.Checked = false; status.Text = "";
          Hide();
          client.Created(id);
        });
      });
      t.IsBackground = true; t.Start();
    }

    protected override void OnFormClosing(FormClosingEventArgs e) {
      if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); }
      base.OnFormClosing(e);
    }
  }

  sealed class TicketsForm : Form {
    readonly TicketClient client;
    readonly ListBox list = new ListBox();
    readonly RichTextBox detail = new RichTextBox();
    readonly TextBox reply = new TextBox();
    readonly Button send = new Button();
    readonly Label status = new Label();
    readonly List<Dictionary<string, object>> tickets = new List<Dictionary<string, object>>();

    public TicketsForm(TicketClient client, Icon icon) {
      this.client = client;
      Text = "My support tickets"; Icon = icon; Width = 560; Height = 600; MinimumSize = new Size(420, 460);
      StartPosition = FormStartPosition.CenterScreen; Font = new Font("Segoe UI", 9.5f);
      var head = new Panel { Dock = DockStyle.Top, Height = 34, BackColor = Color.FromArgb(37, 99, 235) };
      head.Controls.Add(new Label { Dock = DockStyle.Fill, Text = "  Support tickets from this computer", TextAlign = ContentAlignment.MiddleLeft, ForeColor = Color.White, Font = new Font("Segoe UI", 10.5f, FontStyle.Bold) });
      var newBtn = new Button { Text = "New ticket...", Dock = DockStyle.Right, Width = 100, FlatStyle = FlatStyle.Flat, ForeColor = Color.White };
      newBtn.FlatAppearance.BorderSize = 0;
      head.Controls.Add(newBtn);
      list.Dock = DockStyle.Top; list.Height = 130; list.IntegralHeight = false; list.BorderStyle = BorderStyle.None;
      detail.Dock = DockStyle.Fill; detail.ReadOnly = true; detail.BorderStyle = BorderStyle.None; detail.BackColor = Color.White; detail.DetectUrls = true;
      detail.LinkClicked += (s, e) => { try { System.Diagnostics.Process.Start(e.LinkText); } catch { } };
      var sep = new Panel { Dock = DockStyle.Top, Height = 1, BackColor = Color.Gainsboro };
      var bottom = new Panel { Dock = DockStyle.Bottom, Height = 96, Padding = new Padding(8) };
      reply.Multiline = true; reply.Dock = DockStyle.Fill; reply.ScrollBars = ScrollBars.Vertical;
      send.Text = "Reply"; send.Dock = DockStyle.Right; send.Width = 76;
      status.Dock = DockStyle.Bottom; status.Height = 18; status.ForeColor = Color.Gray; status.Font = new Font("Segoe UI", 8f);
      bottom.Controls.Add(reply); bottom.Controls.Add(send); bottom.Controls.Add(status);
      Controls.Add(detail); Controls.Add(sep); Controls.Add(list); Controls.Add(bottom); Controls.Add(head);
      list.SelectedIndexChanged += delegate { ShowSelected(); };
      send.Click += delegate { DoReply(); };
      newBtn.Click += delegate { client.ShowNew(); };
    }

    Dictionary<string, object> Selected() { int i = list.SelectedIndex; return i >= 0 && i < tickets.Count ? tickets[i] : null; }

    public void Reload(long select) {
      long keep = select > 0 ? select : (Selected() != null ? Convert.ToInt64(Selected()["id"]) : 0);
      status.Text = "Loading...";
      var t = new Thread(() => {
        System.Collections.ArrayList data = null; string err = null;
        try { data = client.Fetch(); } catch (Exception e) { err = TicketClient.ErrorText(e); }
        if (IsDisposed) return;
        BeginInvoke((MethodInvoker)delegate {
          if (err != null) { status.Text = "Couldn't load tickets: " + err; return; }
          tickets.Clear(); list.Items.Clear();
          int sel = 0;
          foreach (Dictionary<string, object> d in data) {
            if (Convert.ToInt64(d["id"]) == keep) sel = tickets.Count;
            tickets.Add(d);
            list.Items.Add("#" + d["id"] + "   " + d["subject"] + "   [" + d["status_text"] + "]");
          }
          status.Text = tickets.Count == 0 ? "No tickets yet. Click \"New ticket...\" to ask for help." : "Enter a reply below.";
          if (tickets.Count > 0) list.SelectedIndex = sel; else detail.Clear();
        });
      });
      t.IsBackground = true; t.Start();
    }

    void ShowSelected() {
      var d = Selected();
      detail.Clear();
      if (d == null) return;
      string st = Convert.ToString(d["status"]);
      reply.Enabled = send.Enabled = st != "closed";
      detail.SelectionFont = new Font(Font.FontFamily, 11f, FontStyle.Bold);
      detail.AppendText("#" + d["id"] + " " + d["subject"] + "\n");
      detail.SelectionFont = Font; detail.SelectionColor = Color.Gray;
      detail.AppendText("Status: " + d["status_text"] + "\n\n");
      long newest = 0;
      foreach (Dictionary<string, object> m in (System.Collections.ArrayList)d["thread"]) {
        bool tech = Convert.ToBoolean(m["tech"]);
        if (tech) newest = Math.Max(newest, Convert.ToInt64(m["id"]));
        DateTime at = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(Convert.ToDouble(m["created_at"])).ToLocalTime();
        detail.SelectionFont = new Font(Font, FontStyle.Bold);
        detail.SelectionColor = tech ? Color.FromArgb(37, 99, 235) : Color.FromArgb(22, 101, 52);
        detail.AppendText(Convert.ToString(m["author"]) + "  ");
        detail.SelectionFont = Font; detail.SelectionColor = Color.Gray;
        detail.AppendText(at.ToString("g") + "\n");
        detail.SelectionColor = Color.Black;
        detail.AppendText(m["body"] + "\n\n");
      }
      client.MarkSeen(Convert.ToInt64(d["id"]), newest);
      detail.SelectionStart = detail.TextLength; detail.ScrollToCaret();
    }

    void DoReply() {
      var d = Selected();
      string text = reply.Text.Trim();
      if (d == null || text.Length == 0) return;
      long id = Convert.ToInt64(d["id"]);
      send.Enabled = false; status.Text = "Sending...";
      var t = new Thread(() => {
        string err = client.Reply(id, text);
        BeginInvoke((MethodInvoker)delegate {
          send.Enabled = true;
          if (err != null) { status.Text = "Couldn't send: " + err; return; }
          reply.Clear(); Reload(id);
        });
      });
      t.IsBackground = true; t.Start();
    }

    protected override void OnFormClosing(FormClosingEventArgs e) {
      if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); }
      base.OnFormClosing(e);
    }
  }
}
