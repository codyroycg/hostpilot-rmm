# HostPilot RMM remote-control helper.
# Launched by agent.ps1 into the active console session (as SYSTEM when the agent runs as SYSTEM, so it can
# also see UAC prompts and the login screen). Streams changed screen tiles as JPEG over a WebSocket and
# injects mouse/keyboard input received from the technician's browser.
param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue

function Write-RemoteLog([string]$m) {
    try { Add-Content -LiteralPath ([string]$cfg.log) -Value ("{0}  {1}" -f (Get-Date -Format s), $m) } catch {}
}

$source = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace HostPilotRemote {
  public static class Host {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectInformationW(IntPtr obj, int index, byte[] info, int length, out int needed);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);

    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }

    const int TILE = 64;
    const int MAX_INFLIGHT = 2;

    static ClientWebSocket ws;
    static readonly BlockingCollection<string> inputs = new BlockingCollection<string>();
    static readonly CancellationTokenSource cts = new CancellationTokenSource();
    static readonly HashSet<int> extendedKeys = new HashSet<int> { 33, 34, 35, 36, 37, 38, 39, 40, 45, 46, 91, 92, 93, 111, 144, 163, 165 };
    static int inflight;
    static long lastAckTicks;
    static volatile bool wantFull = true;
    static volatile int quality = 60;
    static float scale = 1f;
    static IntPtr curDesk = IntPtr.Zero;
    static string curDeskName = "";
    static int vx, vy, vw, vh;
    static Exception captureError;

    public static void Run(string url) {
      SetProcessDPIAware();
      ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
      ws = new ClientWebSocket();
      ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
      if (!ws.ConnectAsync(new Uri(url), cts.Token).Wait(20000)) throw new TimeoutException("WebSocket connect timed out");
      Thread rx = new Thread(ReceiveLoop);
      rx.IsBackground = true;
      rx.Start();
      // Capture + input run on one dedicated thread: SetThreadDesktop needs a thread that owns no windows.
      Thread cap = new Thread(CaptureLoop);
      cap.IsBackground = true;
      cap.Start();
      cap.Join(TimeSpan.FromHours(12));
      cts.Cancel();
      try { ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None).Wait(3000); } catch { }
      if (captureError != null) throw captureError;
    }

    static void ReceiveLoop() {
      byte[] buf = new byte[16384];
      MemoryStream ms = new MemoryStream();
      try {
        while (ws.State == WebSocketState.Open && !cts.IsCancellationRequested) {
          WebSocketReceiveResult r = ws.ReceiveAsync(new ArraySegment<byte>(buf), cts.Token).Result;
          if (r.MessageType == WebSocketMessageType.Close) break;
          ms.Write(buf, 0, r.Count);
          if (!r.EndOfMessage) continue;
          string s = Encoding.UTF8.GetString(ms.ToArray());
          ms.SetLength(0);
          if (s == "ack") {
            if (Interlocked.Decrement(ref inflight) < 0) Interlocked.Exchange(ref inflight, 0);
            Interlocked.Exchange(ref lastAckTicks, DateTime.UtcNow.Ticks);
          } else if (s == "bye") {
            break;
          } else {
            inputs.Add(s);
          }
        }
      } catch { }
      cts.Cancel();
    }

    static void CaptureLoop() {
      try {
        ImageCodecInfo jpeg = null;
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
        int[] prev = null;
        int pw = 0, ph = 0, failures = 0;
        string ev;
        while (!cts.IsCancellationRequested) {
          SwitchToInputDesktop();
          while (inputs.TryTake(out ev)) HandleInput(ev);

          if (Interlocked.CompareExchange(ref inflight, 0, 0) >= MAX_INFLIGHT) {
            // viewer hasn't caught up; recover if acks stop arriving entirely
            if (DateTime.UtcNow.Ticks - Interlocked.Read(ref lastAckTicks) > TimeSpan.TicksPerSecond * 5) {
              Interlocked.Exchange(ref inflight, 0);
              wantFull = true;
            }
            if (inputs.TryTake(out ev, 10)) HandleInput(ev);
            continue;
          }

          vx = GetSystemMetrics(76); vy = GetSystemMetrics(77); vw = GetSystemMetrics(78); vh = GetSystemMetrics(79);
          float sc = scale;
          int ow = Math.Max(1, (int)(vw * sc)), oh = Math.Max(1, (int)(vh * sc));
          Bitmap bmp;
          try { bmp = Grab(ow, oh); failures = 0; }
          catch (Exception) {
            // desktop switch (UAC / lock screen) in progress: re-attach and retry
            if (++failures > 300) throw;
            curDeskName = "";
            Thread.Sleep(100);
            continue;
          }
          using (bmp) {
            BitmapData bd = bmp.LockBits(new Rectangle(0, 0, ow, oh), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
            int[] px = new int[ow * oh];
            Marshal.Copy(bd.Scan0, px, 0, px.Length);
            bmp.UnlockBits(bd);
            bool sizeChanged = pw != ow || ph != oh;
            if (sizeChanged) SendText("{\"t\":\"info\",\"w\":" + ow + ",\"h\":" + oh + ",\"desktop\":\"" + curDeskName + "\"}");
            bool full = wantFull || prev == null || sizeChanged;
            wantFull = false;
            List<Rectangle> rects = full ? Strips(ow, oh) : Diff(px, prev, ow, oh);
            if (rects.Count > 0) {
              Interlocked.Increment(ref inflight);
              Interlocked.Exchange(ref lastAckTicks, DateTime.UtcNow.Ticks);
              SendRects(bmp, rects, jpeg);
            }
            prev = px; pw = ow; ph = oh;
          }
          if (inputs.TryTake(out ev, 33)) HandleInput(ev);
        }
      } catch (Exception e) {
        if (!cts.IsCancellationRequested) captureError = e;
      } finally {
        cts.Cancel();
      }
    }

    static Bitmap Grab(int ow, int oh) {
      Bitmap full = new Bitmap(vw, vh, PixelFormat.Format32bppRgb);
      try {
        using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(vx, vy, 0, 0, new Size(vw, vh), CopyPixelOperation.SourceCopy);
        if (ow == vw && oh == vh) return full;
        Bitmap scaled = new Bitmap(ow, oh, PixelFormat.Format32bppRgb);
        using (Graphics g = Graphics.FromImage(scaled)) {
          g.InterpolationMode = InterpolationMode.Bilinear;
          g.DrawImage(full, 0, 0, ow, oh);
        }
        full.Dispose();
        return scaled;
      } catch {
        full.Dispose();
        throw;
      }
    }

    static List<Rectangle> Strips(int w, int h) {
      List<Rectangle> list = new List<Rectangle>();
      for (int y = 0; y < h; y += TILE) list.Add(new Rectangle(0, y, w, Math.Min(TILE, h - y)));
      return list;
    }

    // Compare 64x64 tiles against the previous frame; merge horizontal runs of changed tiles.
    static List<Rectangle> Diff(int[] cur, int[] prev, int w, int h) {
      List<Rectangle> list = new List<Rectangle>();
      for (int ty = 0; ty < h; ty += TILE) {
        int th = Math.Min(TILE, h - ty);
        int runStart = -1;
        for (int tx = 0; ; tx += TILE) {
          bool end = tx >= w;
          bool changed = !end && TileChanged(cur, prev, w, tx, ty, Math.Min(TILE, w - tx), th);
          if (changed && runStart < 0) runStart = tx;
          else if (!changed && runStart >= 0) {
            list.Add(new Rectangle(runStart, ty, Math.Min(tx, w) - runStart, th));
            runStart = -1;
          }
          if (end) break;
        }
      }
      return list;
    }

    static bool TileChanged(int[] cur, int[] prev, int w, int x0, int y0, int tw, int th) {
      for (int y = y0; y < y0 + th; y++) {
        int o = y * w + x0;
        for (int x = 0; x < tw; x++) if (cur[o + x] != prev[o + x]) return true;
      }
      return false;
    }

    // Binary message: [byte 2] then repeated { u16 x, u16 y, u16 w, u16 h, u32 len, jpeg bytes }
    static void SendRects(Bitmap bmp, List<Rectangle> rects, ImageCodecInfo jpeg) {
      EncoderParameters ep = new EncoderParameters(1);
      ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
      using (MemoryStream ms = new MemoryStream())
      using (BinaryWriter bw = new BinaryWriter(ms)) {
        bw.Write((byte)2);
        foreach (Rectangle r in rects) {
          using (Bitmap part = bmp.Clone(r, PixelFormat.Format24bppRgb))
          using (MemoryStream js = new MemoryStream()) {
            part.Save(js, jpeg, ep);
            bw.Write((ushort)r.X); bw.Write((ushort)r.Y); bw.Write((ushort)r.Width); bw.Write((ushort)r.Height);
            bw.Write((uint)js.Length);
            bw.Write(js.GetBuffer(), 0, (int)js.Length);
          }
        }
        bw.Flush();
        Send(new ArraySegment<byte>(ms.GetBuffer(), 0, (int)ms.Length), WebSocketMessageType.Binary);
      }
    }

    static void Send(ArraySegment<byte> data, WebSocketMessageType type) {
      ws.SendAsync(data, type, true, cts.Token).Wait();
    }

    static void SendText(string s) {
      Send(new ArraySegment<byte>(Encoding.UTF8.GetBytes(s)), WebSocketMessageType.Text);
    }

    // Follow the active input desktop (Default <-> Winlogon for UAC prompts / lock screen).
    static void SwitchToInputDesktop() {
      IntPtr d = OpenInputDesktop(0, false, 0x10000000);
      if (d == IntPtr.Zero) return;
      byte[] buf = new byte[512];
      int needed;
      string name = "";
      if (GetUserObjectInformationW(d, 2, buf, buf.Length, out needed)) name = Encoding.Unicode.GetString(buf).TrimEnd('\0');
      if (name != curDeskName && SetThreadDesktop(d)) {
        if (curDesk != IntPtr.Zero) CloseDesktop(curDesk);
        curDesk = d;
        curDeskName = name;
        wantFull = true;
        return;
      }
      CloseDesktop(d);
    }

    static float F(string s) { return float.Parse(s, CultureInfo.InvariantCulture); }

    // Input protocol (text): "mm x y" | "md btn x y" | "mu btn x y" | "wh delta" | "kd vk" | "ku vk"
    //                        | "type <base64 utf8>" | "q scale quality" | "full"   (x,y normalised 0..1)
    static void HandleInput(string msg) {
      string[] p = msg.Split(' ');
      try {
        switch (p[0]) {
          case "mm": Mouse(F(p[1]), F(p[2]), 0, 0); break;
          case "md": Mouse(F(p[2]), F(p[3]), ButtonFlag(int.Parse(p[1]), true), 0); break;
          case "mu": Mouse(F(p[2]), F(p[3]), ButtonFlag(int.Parse(p[1]), false), 0); break;
          case "wh": Mouse(-1, -1, 0x0800, int.Parse(p[1])); break;
          case "kd": Key(ushort.Parse(p[1]), false); break;
          case "ku": Key(ushort.Parse(p[1]), true); break;
          case "type": TypeText(Encoding.UTF8.GetString(Convert.FromBase64String(p[1]))); break;
          case "q":
            scale = Math.Max(0.25f, Math.Min(1f, F(p[1])));
            quality = Math.Max(10, Math.Min(95, int.Parse(p[2])));
            wantFull = true;
            break;
          case "full": wantFull = true; break;
        }
      } catch { }
    }

    static uint ButtonFlag(int button, bool down) {
      if (button == 2) return down ? 0x0008u : 0x0010u;
      if (button == 1) return down ? 0x0020u : 0x0040u;
      return down ? 0x0002u : 0x0004u;
    }

    static void Mouse(float x, float y, uint flags, int data) {
      INPUT i = new INPUT();
      i.type = 0;
      if (x >= 0) {
        i.u.mi.dx = (int)(Math.Max(0f, Math.Min(1f, x)) * 65535);
        i.u.mi.dy = (int)(Math.Max(0f, Math.Min(1f, y)) * 65535);
        flags |= 0x0001 | 0x8000 | 0x4000; // MOVE | ABSOLUTE | VIRTUALDESK
      }
      i.u.mi.dwFlags = flags;
      i.u.mi.mouseData = unchecked((uint)data);
      SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Key(ushort vk, bool up) {
      INPUT i = new INPUT();
      i.type = 1;
      i.u.ki.wVk = vk;
      i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
      uint f = 0;
      if (up) f |= 0x0002;
      if (extendedKeys.Contains(vk)) f |= 0x0001;
      i.u.ki.dwFlags = f;
      SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
    }

    static void TypeText(string s) {
      foreach (char c in s) {
        if (c == '\r') continue;
        if (c == '\n') { Key(13, false); Key(13, true); continue; }
        for (int k = 0; k < 2; k++) {
          INPUT i = new INPUT();
          i.type = 1;
          i.u.ki.wScan = c;
          i.u.ki.dwFlags = 0x0004 | (k == 1 ? 0x0002u : 0u); // UNICODE (| KEYUP)
          SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
        }
      }
    }
  }
}
'@

try {
    Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Drawing' -Language CSharp
    Write-RemoteLog 'remote session starting'
    [HostPilotRemote.Host]::Run([string]$cfg.url)
    Write-RemoteLog 'remote session ended'
} catch {
    Write-RemoteLog "remote session failed: $($_.Exception.ToString())"
    exit 1
}
