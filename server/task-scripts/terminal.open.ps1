# HostPilot task: interactive Command Prompt / PowerShell session, hidden (no window on the user's desktop).
# Keystrokes arrive over one long-lived HTTPS GET ("D <base64>", "R rows cols", "X"); output is POSTed in small batches.
# Windows has no pseudo-terminal for redirected processes, so this relay does the line editing itself:
# echo, backspace, history (up/down), Ctrl+C. Each command line is sent to a persistent cmd.exe / powershell.exe,
# followed by a marker command that prints the current directory so the prompt can be redrawn when it finishes.
#__ARGS__
#__INCLUDE:_server.ps1__
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

namespace HostPilotTerm {
  public class Relay {
    const string Marker = "__HP_DONE__";
    // cmd.exe prints its banner and a prompt before every command even with redirected input;
    // we give it this private prompt and strip it, and drop the blank line cmd adds before each prompt
    const string CmdPrompt = "__HP_P__";
    volatile bool starting;
    bool pendingBlank;
    readonly string inUrl, outUrl, closeUrl, mode;
    Process proc;
    readonly StringBuilder line = new StringBuilder();
    readonly List<string> history = new List<string>();
    int histPos = -1;
    volatile bool busy;
    string cwd = "";
    readonly StringBuilder outBuf = new StringBuilder();
    readonly object outLock = new object();
    volatile bool done;

    public Relay(string inUrl, string outUrl, string closeUrl, string mode) { this.inUrl = inUrl; this.outUrl = outUrl; this.closeUrl = closeUrl; this.mode = mode; }

    string Prompt() { return mode == "powershell" ? "PS " + cwd + "> " : cwd + ">"; }
    void Emit(string s) { lock (outLock) outBuf.Append(s); }

    void Flusher() {
      while (!done) {
        Thread.Sleep(40);
        string s;
        lock (outLock) { if (outBuf.Length == 0) continue; s = outBuf.ToString(); outBuf.Clear(); }
        Post(outUrl, Encoding.UTF8.GetBytes(s));
      }
    }
    static void Post(string url, byte[] body) {
      try {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = "POST"; req.ContentType = "application/octet-stream"; req.Timeout = 15000;
        req.ContentLength = body.Length;
        if (body.Length > 0) using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
        using (req.GetResponse()) { }
      } catch { }
    }

    void StartShell() {
      var psi = new ProcessStartInfo();
      if (mode == "powershell") {
        psi.FileName = Environment.ExpandEnvironmentVariables(@"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe");
        psi.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -";
      } else {
        psi.FileName = Environment.ExpandEnvironmentVariables(@"%SystemRoot%\System32\cmd.exe");
        psi.Arguments = "/Q /D";
      }
      psi.UseShellExecute = false; psi.CreateNoWindow = true;
      psi.RedirectStandardInput = true; psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
      psi.StandardOutputEncoding = Encoding.UTF8; psi.StandardErrorEncoding = Encoding.UTF8;
      psi.WorkingDirectory = Environment.ExpandEnvironmentVariables("%SystemDrive%\\");
      if (mode != "powershell") psi.EnvironmentVariables["PROMPT"] = CmdPrompt;
      starting = true; pendingBlank = false;
      proc = Process.Start(psi);
      var stdout = proc.StandardOutput; var stderr = proc.StandardError;
      new Thread(() => ReadLoop(stdout, false)) { IsBackground = true }.Start();
      new Thread(() => ReadLoop(stderr, true)) { IsBackground = true }.Start();
      if (mode == "powershell") Send("[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; $ProgressPreference = 'SilentlyContinue'");
      else Send("chcp 65001 >nul");
      busy = true; SendMarker();
    }
    void Send(string s) { try { proc.StandardInput.Write(s + "\n"); proc.StandardInput.Flush(); } catch { } }
    void SendMarker() { Send(mode == "powershell" ? "Write-Output ('" + Marker + "' + $PWD.ProviderPath)" : "echo " + Marker + "%CD%"); }

    void ReadLoop(StreamReader r, bool err) {
      try {
        string l;
        while ((l = r.ReadLine()) != null) {
          if (!err && mode != "powershell") {
            bool hadPrompt = false;
            while (l.StartsWith(CmdPrompt, StringComparison.Ordinal)) { l = l.Substring(CmdPrompt.Length); hadPrompt = true; }
            if (hadPrompt) pendingBlank = false;           // the blank line before a prompt is cmd's, not output
            if (pendingBlank) { Emit("\r\n"); pendingBlank = false; }
            if (l.Length == 0) { if (!hadPrompt && !starting) pendingBlank = true; continue; }
          }
          int m = l.IndexOf(Marker, StringComparison.Ordinal);
          if (!err && m >= 0) {
            if (m > 0 && !starting) Emit(l.Substring(0, m) + "\r\n");
            cwd = l.Substring(m + Marker.Length).Trim();
            starting = false;
            busy = false;
            Emit(Prompt() + line.ToString());
            continue;
          }
          if (starting && !err) continue; // banner / setup output
          Emit(err ? "\x1b[31m" + l + "\x1b[0m\r\n" : l + "\r\n");
        }
      } catch { }
    }

    void Erase(int n) { var sb = new StringBuilder(); for (int i = 0; i < n; i++) sb.Append("\b \b"); Emit(sb.ToString()); }

    void Key(string data) {
      for (int i = 0; i < data.Length; i++) {
        char c = data[i];
        if (c == '\x1b' && i + 2 < data.Length && data[i + 1] == '[') {
          char k = data[i + 2]; i += 2;
          if ((k == 'A' || k == 'B') && history.Count > 0 && !busy) {
            if (k == 'A') histPos = histPos < 0 ? history.Count - 1 : Math.Max(0, histPos - 1);
            else histPos = histPos < 0 ? -1 : histPos + 1;
            string next = histPos >= 0 && histPos < history.Count ? history[histPos] : "";
            if (histPos >= history.Count) histPos = -1;
            Erase(line.Length); line.Clear(); line.Append(next); Emit(next);
          }
          while (i < data.Length && !char.IsLetter(data[i]) && data[i] != '~') i++; // skip other sequences
          continue;
        }
        if (c == '\r' || (c == '\n' && (i == 0 || data[i - 1] != '\r'))) {
          string cmd = line.ToString(); line.Clear(); histPos = -1;
          Emit("\r\n");
          if (cmd.Trim().Length > 0 && (history.Count == 0 || history[history.Count - 1] != cmd)) history.Add(cmd);
          if (cmd.Trim() == "exit") { done = true; return; }
          if (cmd.Trim() == "cls" || cmd.Trim() == "clear") { Emit("\x1b[2J\x1b[H"); }
          busy = true; Send(cmd); SendMarker();
          continue;
        }
        if (c == '\n') continue;
        if (c == '\x7f' || c == '\b') { if (line.Length > 0) { line.Length--; Emit("\b \b"); } continue; }
        if (c == '\x03') { // Ctrl+C
          if (busy) {
            Emit("^C\r\n\x1b[33m(stopping the running command restarts the " + (mode == "powershell" ? "PowerShell" : "Command Prompt") + " session)\x1b[0m\r\n");
            try { KillTree(proc.Id); } catch { }
            line.Clear(); StartShell();
          } else { line.Clear(); Emit("^C\r\n" + Prompt()); }
          continue;
        }
        if (c == '\t') continue;
        if (c < ' ') continue;
        line.Append(c); Emit(c.ToString());
      }
    }

    static void KillTree(int pid) {
      var p = Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + pid + " /T /F") { CreateNoWindow = true, UseShellExecute = false });
      p.WaitForExit(5000);
    }

    public void Run() {
      new Thread(Flusher) { IsBackground = true }.Start();
      Emit("\x1b[36m" + (mode == "powershell" ? "Windows PowerShell" : "Command Prompt") + " on " + Environment.MachineName +
           " (HostPilot background session, runs as " + Environment.UserName + "; the signed-in user sees nothing)\x1b[0m\r\n" +
           "\x1b[90mType commands and press Enter. Full-screen and interactive programs aren't supported. Ctrl+C stops a running command.\x1b[0m\r\n\r\n");
      StartShell();
      try {
        var req = (HttpWebRequest)WebRequest.Create(inUrl);
        req.Timeout = Timeout.Infinite; req.ReadWriteTimeout = Timeout.Infinite;
        using (var resp = req.GetResponse())
        using (var r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) {
          string l;
          while (!done && (l = r.ReadLine()) != null) {
            if (l.StartsWith("D ")) {
              try { Key(Encoding.UTF8.GetString(Convert.FromBase64String(l.Substring(2)))); } catch (FormatException) { }
            } else if (l == "X") break;
            if (proc.HasExited && !busy) { Emit("\r\n[shell exited]\r\n"); break; }
          }
        }
      } catch { }
      done = true;
      try { if (!proc.HasExited) KillTree(proc.Id); } catch { }
      Thread.Sleep(100);
      string rest; lock (outLock) { rest = outBuf.ToString(); outBuf.Clear(); }
      if (rest.Length > 0) Post(outUrl, Encoding.UTF8.GetBytes(rest));
      Post(closeUrl, new byte[0]);
    }
  }
}
'@
if (-not ('HostPilotTerm.Relay' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
[HostPilotTerm.Relay]::new("$HP$($A['in'])", "$HP$($A['out'])", "$HP$($A['close'])", $A['shell']).Run()
'Session ended'
