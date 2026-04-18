using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        try
        {
            string repoRoot = ResolveRepoRoot();
            string trayScript = Path.Combine(repoRoot, "scripts", "wechat-bridge-tray.ps1");
            if (!File.Exists(trayScript))
            {
                MessageBox.Show(
                    "Cannot find scripts\\wechat-bridge-tray.ps1 relative to the launcher.",
                    "WeChat Bridge",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + trayScript + "\" -RepoRoot \"" + repoRoot + "\"",
                WorkingDirectory = repoRoot,
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };

            Process.Start(startInfo);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                error.Message,
                "WeChat Bridge",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
    }

    private static string ResolveRepoRoot()
    {
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", ".."));
    }
}
