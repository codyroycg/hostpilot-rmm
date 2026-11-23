// HostPilot RMM - Windows agent setup (double-click installer).
// The server appends "\n##HOSTPILOT-CONFIG##<server url>\n<enrollment token>\n" to this exe when it is
// downloaded, so each download is pre-configured for one client. This program reads that block,
// downloads the PowerShell installer from the server, and runs it elevated (see app.manifest).
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("HostPilot RMM Setup")]
[assembly: AssemblyProduct("HostPilot RMM")]
[assembly: AssemblyVersion("1.0.0.0")]

static class HostPilotSetup
{
    const string Marker = "##HOSTPILOT-CONFIG##";
    const string Title = "HostPilot RMM Setup";

    [STAThread]
    static int Main(string[] args)
    {
        string server, token;
        if (!ReadConfig(out server, out token))
        {
            MessageBox.Show("This installer is not configured. Download it again from the HostPilot console (Clients -> your client -> Download installer).",
                Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }

        // test hook for the build script: write the embedded config and exit
        if (args.Length == 2 && args[0] == "--print-config")
        {
            File.WriteAllText(args[1], server + "\n" + token + "\n");
            return 0;
        }

        bool quiet = args.Length > 0 && (args[0] == "/quiet" || args[0] == "/S" || args[0] == "--quiet");
        if (!quiet)
        {
            DialogResult ok = MessageBox.Show(
                "Install the HostPilot remote management agent on this computer?\n\n" +
                "It will be managed by:\n" + server + "\n\n" +
                "Your IT provider will be able to monitor this computer, run maintenance tasks and connect remotely.",
                Title, MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (ok != DialogResult.OK) return 1;
        }

        string output;
        int code = Install(server, token, out output);
        if (!quiet)
        {
            if (code == 0)
                MessageBox.Show("HostPilot agent installed successfully.\n\nThis computer will appear in the console within a minute.", Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            else
                MessageBox.Show("Installation failed (code " + code + ").\n\n" + Tail(output, 1500), Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        return code;
    }

    static bool ReadConfig(out string server, out string token)
    {
        server = null; token = null;
        string self = Assembly.GetExecutingAssembly().Location;
        byte[] all = File.ReadAllBytes(self);
        int start = Math.Max(0, all.Length - 8192);
        string tail = Encoding.UTF8.GetString(all, start, all.Length - start);
        int i = tail.LastIndexOf(Marker, StringComparison.Ordinal);
        if (i < 0) return false;
        string[] lines = tail.Substring(i + Marker.Length).Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length < 2) return false;
        server = lines[0].Trim().TrimEnd('/');
        token = lines[1].Trim();
        return server.StartsWith("http") && token.Length >= 16;
    }

    static int Install(string server, string token, out string output)
    {
        string script = Path.Combine(Path.GetTempPath(), "hostpilot-install-" + Guid.NewGuid().ToString("N") + ".ps1");
        try
        {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2
            using (WebClient wc = new WebClient())
            {
                wc.Encoding = Encoding.UTF8;
                string body = wc.DownloadString(server + "/install/windows?token=" + Uri.EscapeDataString(token));
                File.WriteAllText(script, body, new UTF8Encoding(true));
            }
            ProcessStartInfo psi = new ProcessStartInfo(
                Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
                "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            using (Process p = Process.Start(psi))
            {
                string err = null;
                p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) err += e.Data + "\n"; };
                p.BeginErrorReadLine();
                string outp = p.StandardOutput.ReadToEnd();
                p.WaitForExit();
                output = outp + (err ?? "");
                return p.ExitCode;
            }
        }
        catch (Exception e)
        {
            output = e.Message;
            return 1;
        }
        finally
        {
            try { File.Delete(script); } catch { }
        }
    }

    static string Tail(string s, int max)
    {
        if (string.IsNullOrEmpty(s)) return "(no output)";
        return s.Length <= max ? s : "..." + s.Substring(s.Length - max);
    }
}
