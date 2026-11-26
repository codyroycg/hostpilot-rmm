# HostPilot task: take a screenshot of the console session (what's on the monitor) and upload it as JPEG.
# The agent runs as SYSTEM in session 0, so the capture runs in the active console session instead.
#__ARGS__
#__INCLUDE:_server.ps1__
$ErrorActionPreference = 'Stop'
$isSystem = [Security.Principal.WindowsIdentity]::GetCurrent().IsSystem
# as SYSTEM: the agent's own (SYSTEM-only) folder; otherwise (testing interactively) the user's temp folder
$dir = if ($isSystem) { Join-Path $env:ProgramData 'HostPilot\shots' } else { Join-Path $env:TEMP 'hostpilot-shots' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$name = [guid]::NewGuid().ToString('N')
$out = Join-Path $dir "$name.jpg"
$errFile = Join-Path $dir "$name.err"
$capture = Join-Path $dir "$name.ps1"
@"
`$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    Add-Type -Name Dpi -Namespace HP -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
    [void][HP.Dpi]::SetProcessDPIAware()
    `$b = [Windows.Forms.SystemInformation]::VirtualScreen
    `$bmp = New-Object Drawing.Bitmap `$b.Width, `$b.Height
    `$g = [Drawing.Graphics]::FromImage(`$bmp)
    `$g.CopyFromScreen(`$b.X, `$b.Y, 0, 0, `$bmp.Size)
    `$g.Dispose()
    if (`$bmp.Width -gt 2560) {   # keep big multi-monitor captures reasonable
        `$h = [int](`$bmp.Height * 2560 / `$bmp.Width)
        `$small = New-Object Drawing.Bitmap `$bmp, 2560, `$h
        `$bmp.Dispose(); `$bmp = `$small
    }
    `$enc = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { `$_.MimeType -eq 'image/jpeg' }
    `$p = New-Object Drawing.Imaging.EncoderParameters 1
    `$p.Param[0] = New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality), ([long]75)
    `$bmp.Save('$out.tmp', `$enc, `$p)
    `$bmp.Dispose()
    Move-Item -LiteralPath '$out.tmp' -Destination '$out' -Force
} catch { [IO.File]::WriteAllText('$errFile', `$_.Exception.Message) }
"@ | Set-Content -LiteralPath $capture -Encoding UTF8

$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$cmd = "`"$ps`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$capture`""
try {
    if ($isSystem) {
        if (-not ('HostPilotShot.SessionLauncher' -as [type])) {
            Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace HostPilotShot {
  public static class SessionLauncher {
    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attrs, int level, int type, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, ref uint info, int len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
      public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    public static void Launch(string cmd) {
      uint session = WTSGetActiveConsoleSessionId();
      if (session == 0xFFFFFFFF) throw new Exception("Nobody is at the console (no active session)");
      IntPtr token, dup;
      if (!OpenProcessToken(GetCurrentProcess(), 0x02000000, out token)) throw new Win32Exception();
      try { if (!DuplicateTokenEx(token, 0x02000000, IntPtr.Zero, 2, 1, out dup)) throw new Win32Exception(); } finally { CloseHandle(token); }
      try {
        if (!SetTokenInformation(dup, 12, ref session, 4)) throw new Win32Exception();
        STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.lpDesktop = "winsta0\\default";
        PROCESS_INFORMATION pi;
        if (!CreateProcessAsUser(dup, null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, null, ref si, out pi)) throw new Win32Exception();
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
      } finally { CloseHandle(dup); }
    }
  }
}
'@
        }
        [HostPilotShot.SessionLauncher]::Launch($cmd)
    } else {
        Start-Process -FilePath $ps -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$capture`"" -WindowStyle Hidden
    }
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path -LiteralPath $out) -and -not (Test-Path -LiteralPath $errFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    if (Test-Path -LiteralPath $errFile) { throw "Capture failed: $(Get-Content -LiteralPath $errFile -Raw) (the screen may be locked or on a UAC prompt)" }
    if (-not (Test-Path -LiteralPath $out)) { throw 'Capture timed out' }
    $bytes = [IO.File]::ReadAllBytes($out)
    $wc = New-Object Net.WebClient
    $wc.Headers['Content-Type'] = 'image/jpeg'
    [void]$wc.UploadData("$HP$($A['url'])", 'PUT', $bytes)
    "Screenshot uploaded ($([math]::Round($bytes.Length / 1KB)) KB)"
} finally {
    Remove-Item -LiteralPath $out, "$out.tmp", $errFile, $capture -Force -ErrorAction SilentlyContinue
}
