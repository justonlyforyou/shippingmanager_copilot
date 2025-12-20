using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Threading;

namespace ShippingManagerCoPilot.Installer.Logic
{
    /// <summary>
    /// Main installer logic class
    /// </summary>
    public class Installer
    {
        private readonly string _installPath;
        private readonly bool _createDesktopShortcut;
        private readonly bool _createStartMenuShortcut;
        private readonly bool _isUpdate;

        // Events for UI updates
        public event Action<int, string> ProgressChanged;
        public event Action<string> StatusChanged;

        public Installer(string installPath, bool createDesktopShortcut, bool createStartMenuShortcut, bool isUpdate = false)
        {
            _installPath = installPath;
            _createDesktopShortcut = createDesktopShortcut;
            _createStartMenuShortcut = createStartMenuShortcut;
            _isUpdate = isUpdate;
        }

        /// <summary>
        /// Executes the installation process
        /// </summary>
        public void Install()
        {
            try
            {
                // Step 1: Check if already installed
                UpdateStatus(_isUpdate ? "Checking update requirements..." : "Checking installation status...");
                UpdateProgress(5, _isUpdate ? "Preparing update" : "Checking existing installation");

                if (RegistryHelper.IsInstalled() && !_isUpdate)
                {
                    var existingPath = RegistryHelper.GetInstallPath();
                    throw new Exception($"ShippingManager CoPilot is already installed at:\n{existingPath}\n\nPlease uninstall the existing version first.");
                }

                // If updating, stop the running application
                if (_isUpdate)
                {
                    UpdateStatus("Stopping running application...");
                    UpdateProgress(8, "Stopping application");
                    StopRunningApplication();
                    Thread.Sleep(1000);
                }

                // Step 2: Create installation directory
                UpdateStatus("Creating installation directory...");
                UpdateProgress(10, "Creating installation directory");

                if (!Directory.Exists(_installPath))
                {
                    Directory.CreateDirectory(_installPath);
                }

                // Step 3: Clean up old files (but preserve userdata)
                if (_isUpdate)
                {
                    UpdateStatus("Cleaning up old application files...");
                    UpdateProgress(15, "Removing old files (preserving userdata)");
                    CleanupOldFiles();
                }

                // Step 4: Extract embedded payload
                UpdateStatus("Extracting application files...");
                UpdateProgress(25, "Extracting application files");

                ExtractEmbeddedPayload();

                UpdateProgress(50, "Application files extracted successfully");

                // Step 5: Create uninstaller
                UpdateStatus("Creating uninstaller...");
                UpdateProgress(60, "Creating uninstaller");

                CreateUninstaller();

                // Step 6: Create shortcuts
                if (_createDesktopShortcut || _createStartMenuShortcut)
                {
                    UpdateStatus("Creating shortcuts...");
                    UpdateProgress(70, "Creating shortcuts");

                    CreateShortcuts();
                }

                // Step 7: Register in Windows
                UpdateStatus("Registering application...");
                UpdateProgress(85, "Registering in Windows");

                // Get version from FileVersionInfo to get actual file version string (not assembly version)
                // Use Environment.ProcessPath instead of Assembly.Location (which returns empty for single-file apps)
                var exePath = Environment.ProcessPath;
                if (string.IsNullOrEmpty(exePath))
                {
                    throw new Exception("Could not determine installer executable path for version check");
                }
                var fileVersionInfo = System.Diagnostics.FileVersionInfo.GetVersionInfo(exePath);
                var version = fileVersionInfo.FileVersion;

                if (string.IsNullOrEmpty(version))
                {
                    throw new Exception("Failed to read version from installer. Build may be corrupted.");
                }

                RegistryHelper.RegisterUninstallEntry(_installPath, version);

                // Step 8: Complete
                UpdateStatus("Installation complete!");
                UpdateProgress(100, "Installation completed successfully");
            }
            catch (Exception ex)
            {
                throw new Exception($"Installation failed: {ex.Message}", ex);
            }
        }

        /// <summary>
        /// Extracts the embedded app-payload.zip to installation directory
        /// </summary>
        private void ExtractEmbeddedPayload()
        {
            var assembly = Assembly.GetExecutingAssembly();
            var resourceName = assembly.GetManifestResourceNames()
                .FirstOrDefault(name => name.EndsWith("app-payload.zip"));

            if (string.IsNullOrEmpty(resourceName))
            {
                throw new Exception("Application payload not found in installer. The installer may be corrupted.");
            }

            using (var stream = assembly.GetManifestResourceStream(resourceName))
            {
                if (stream == null)
                {
                    throw new Exception("Failed to read application payload from installer.");
                }

                // Extract to temp location first
                var tempZipPath = Path.Combine(Path.GetTempPath(), "shippingmanager_payload.zip");

                try
                {
                    // Save stream to temp file
                    using (var fileStream = File.Create(tempZipPath))
                    {
                        stream.CopyTo(fileStream);
                    }

                    // Extract zip to installation directory
                    ZipFile.ExtractToDirectory(tempZipPath, _installPath, overwriteFiles: true);
                }
                finally
                {
                    // Clean up temp file
                    if (File.Exists(tempZipPath))
                    {
                        File.Delete(tempZipPath);
                    }
                }
            }
        }

        /// <summary>
        /// Creates the uninstaller executable
        /// </summary>
        private void CreateUninstaller()
        {
            // Get the actual installer EXE path (where Setup.exe is running from)
            var installerExe = Environment.ProcessPath;
            if (string.IsNullOrEmpty(installerExe))
            {
                throw new Exception("Could not determine installer executable path");
            }

            var installerDir = Path.GetDirectoryName(installerExe);
            if (string.IsNullOrEmpty(installerDir))
            {
                throw new Exception($"Could not determine installer directory from path: {installerExe}");
            }

            var uninstallerDir = Path.Combine(_installPath, "Uninstaller");

            // Create uninstaller directory
            Directory.CreateDirectory(uninstallerDir);

            // Copy the installer EXE as Uninstall.exe
            File.Copy(installerExe, Path.Combine(uninstallerDir, "Uninstall.exe"), overwrite: true);

            // Copy all WPF DLLs that are next to the installer
            var dllFiles = Directory.GetFiles(installerDir, "*.dll");
            foreach (var dllFile in dllFiles)
            {
                var fileName = Path.GetFileName(dllFile);
                var destFile = Path.Combine(uninstallerDir, fileName);
                File.Copy(dllFile, destFile, overwrite: true);
            }
        }

        /// <summary>
        /// Creates desktop and start menu shortcuts
        /// </summary>
        private void CreateShortcuts()
        {
            var exePath = Path.Combine(_installPath, "ShippingManagerCoPilot-Launcher.exe");

            if (!File.Exists(exePath))
            {
                throw new Exception($"Application executable not found at: {exePath}");
            }

            if (_createDesktopShortcut)
            {
                ShortcutHelper.CreateDesktopShortcut(
                    exePath,
                    "ShippingManager CoPilot",
                    "ShippingManager CoPilot - Chat and automation tool for Shipping Manager"
                );
            }

            if (_createStartMenuShortcut)
            {
                ShortcutHelper.CreateStartMenuShortcut(
                    exePath,
                    "ShippingManager CoPilot",
                    "ShippingManager CoPilot - Chat and automation tool for Shipping Manager"
                );
            }
        }

        /// <summary>
        /// Updates installation progress
        /// </summary>
        private void UpdateProgress(int percentage, string message)
        {
            ProgressChanged?.Invoke(percentage, message);
        }

        /// <summary>
        /// Updates installation status
        /// </summary>
        private void UpdateStatus(string status)
        {
            StatusChanged?.Invoke(status);
        }

        /// <summary>
        /// Cleans up old application files while preserving userdata directory
        /// This is called during updates to remove obsolete files (like old Python scripts)
        /// </summary>
        private void CleanupOldFiles()
        {
            // Directories and files to NEVER delete
            var protectedNames = new[]
            {
                "userdata",     // User data - NEVER delete
                "Uninstaller"   // Uninstaller - will be recreated
            };

            // Delete all files in root (except protected)
            var rootFiles = Directory.GetFiles(_installPath);
            foreach (var file in rootFiles)
            {
                try
                {
                    File.Delete(file);
                }
                catch
                {
                    // Ignore files that can't be deleted (might be in use)
                }
            }

            // Delete all directories except protected ones
            var rootDirs = Directory.GetDirectories(_installPath);
            foreach (var dir in rootDirs)
            {
                var dirName = Path.GetFileName(dir);

                // Skip protected directories
                if (protectedNames.Contains(dirName, StringComparer.OrdinalIgnoreCase))
                {
                    continue;
                }

                try
                {
                    Directory.Delete(dir, recursive: true);
                }
                catch
                {
                    // Ignore directories that can't be deleted
                }
            }
        }

        /// <summary>
        /// Stop the running ShippingManagerCoPilot application if it's running
        /// </summary>
        private void StopRunningApplication()
        {
            try
            {
                // Find all processes - both the launcher and server
                var processNames = new[] { "ShippingManagerCoPilot-Launcher", "ShippingManagerCoPilot-Server" };

                foreach (var processName in processNames)
                {
                    var processes = Process.GetProcessesByName(processName);

                    foreach (var process in processes)
                    {
                        try
                        {
                            // Try graceful shutdown first
                            process.CloseMainWindow();

                            // Wait up to 3 seconds for graceful shutdown
                            if (!process.WaitForExit(3000))
                            {
                                // Force kill if still running
                                process.Kill();
                                process.WaitForExit();
                            }
                        }
                        catch
                        {
                            // Ignore errors for individual processes
                        }
                    }
                }
            }
            catch
            {
                // Don't fail update if we can't stop the app
            }
        }
    }
}
