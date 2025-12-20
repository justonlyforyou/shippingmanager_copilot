using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows;

namespace ShippingManagerCoPilot.Installer
{
    public partial class App : Application
    {
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);

            // Check if we need to extract native DLLs (first run from single-file)
            if (RequiresDllExtraction())
            {
                try
                {
                    ExtractNativeDlls();
                    RestartApplication(e.Args);
                    Shutdown();
                    return;
                }
                catch (Exception ex)
                {
                    MessageBox.Show(
                        $"Failed to extract required files: {ex.Message}\n\nPlease run the installer with administrator privileges.",
                        "Installer Error",
                        MessageBoxButton.OK,
                        MessageBoxImage.Error);
                    Shutdown(1);
                    return;
                }
            }

            // Check if started in uninstall mode
            if (e.Args.Length > 0 && e.Args[0] == "/uninstall")
            {
                // Show uninstaller UI
                var uninstallWindow = new UninstallWindow();
                uninstallWindow.Show();
                BringToForeground(uninstallWindow);
            }
            else
            {
                // Show installer UI
                var mainWindow = new MainWindow();
                mainWindow.Show();
                BringToForeground(mainWindow);
            }
        }

        private bool RequiresDllExtraction()
        {
            // Check if critical WPF DLLs exist next to the EXE
            string exeDirectory = AppContext.BaseDirectory;
            string[] requiredDlls = {
                "PresentationNative_cor3.dll",
                "wpfgfx_cor3.dll",
                "PenImc_cor3.dll"
            };

            return requiredDlls.Any(dll => !File.Exists(Path.Combine(exeDirectory, dll)));
        }

        private void ExtractNativeDlls()
        {
            string exeDirectory = AppContext.BaseDirectory;

            // The native DLLs are automatically extracted by .NET when IncludeNativeLibrariesForSelfExtract=true
            // They go to: %TEMP%\.net\<AppName>\<random>\
            // We need to find them and copy them to the EXE directory

            string tempNetFolder = Path.Combine(Path.GetTempPath(), ".net");
            if (!Directory.Exists(tempNetFolder))
            {
                throw new Exception("Native DLLs not found in temp folder");
            }

            // Find the most recent extraction folder
            var extractionFolders = Directory.GetDirectories(tempNetFolder, "*", SearchOption.AllDirectories)
                .Where(d => File.Exists(Path.Combine(d, "PresentationNative_cor3.dll")))
                .OrderByDescending(d => Directory.GetCreationTime(d))
                .ToArray();

            if (extractionFolders.Length == 0)
            {
                throw new Exception("Native DLLs extraction folder not found");
            }

            string sourceFolder = extractionFolders[0];

            // Copy all DLL files from temp to EXE directory
            foreach (string dllFile in Directory.GetFiles(sourceFolder, "*.dll"))
            {
                string fileName = Path.GetFileName(dllFile);
                string destPath = Path.Combine(exeDirectory, fileName);
                File.Copy(dllFile, destPath, overwrite: true);
            }
        }

        private void RestartApplication(string[] args)
        {
            string exePath = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Setup.exe");
            string arguments = string.Join(" ", args.Select(a => $"\"{a}\""));

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = exePath,
                Arguments = arguments,
                UseShellExecute = true
            };

            Process.Start(startInfo);
        }

        private void BringToForeground(Window window)
        {
            window.Topmost = true;
            window.Activate();
            window.Focus();
            window.Topmost = false;
        }
    }
}
