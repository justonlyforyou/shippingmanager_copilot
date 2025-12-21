using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Windows.Forms;

namespace ShippingManagerCoPilot.Launcher
{
    public class TrayIconManager : IDisposable
    {
        private NotifyIcon? _notifyIcon;
        private ContextMenuStrip? _contextMenu;
        private ToolStripMenuItem? _debugModeItem;

        public void Initialize()
        {
            // Create context menu
            _contextMenu = new ContextMenuStrip();
            _contextMenu.Items.Add("Open CoPilot", null, OnOpenClick);
            _contextMenu.Items.Add("-");
            _contextMenu.Items.Add("Restart Servers", null, OnRestartClick);
            _contextMenu.Items.Add("-");

            // Debug Mode toggle
            _debugModeItem = new ToolStripMenuItem("Debug Mode")
            {
                CheckOnClick = true,
                Checked = GetDebugMode()
            };
            _debugModeItem.Click += OnDebugModeClick;
            _contextMenu.Items.Add(_debugModeItem);

            // Open Server Log
            _contextMenu.Items.Add("Open Server Log", null, OnOpenLogClick);
            _contextMenu.Items.Add("-");
            _contextMenu.Items.Add("Exit", null, OnExitClick);

            // Create tray icon
            _notifyIcon = new NotifyIcon
            {
                Text = "ShippingManager CoPilot",
                ContextMenuStrip = _contextMenu,
                Visible = true
            };

            // Load icon - try multiple locations
            Icon? trayIcon = null;

            // Try 1: Same directory as executable
            var iconPath = Path.Combine(App.AppDirectory, "icon.ico");
            if (File.Exists(iconPath))
            {
                trayIcon = new Icon(iconPath);
                Logger.Debug($"[Tray] Loaded icon from: {iconPath}");
            }

            // Try 2: Embedded resource
            if (trayIcon == null)
            {
                try
                {
                    var assembly = System.Reflection.Assembly.GetExecutingAssembly();
                    using var stream = assembly.GetManifestResourceStream("ShippingManagerCoPilot.Launcher.icon.ico");
                    if (stream != null)
                    {
                        trayIcon = new Icon(stream);
                        Logger.Debug("[Tray] Loaded icon from embedded resource");
                    }
                }
                catch (Exception ex)
                {
                    Logger.Debug($"[Tray] Could not load embedded resource: {ex.Message}");
                }
            }

            // Try 3: WPF resource (pack URI)
            if (trayIcon == null)
            {
                try
                {
                    var resourceInfo = System.Windows.Application.GetResourceStream(new Uri("pack://application:,,,/icon.ico"));
                    if (resourceInfo != null)
                    {
                        trayIcon = new Icon(resourceInfo.Stream);
                        Logger.Debug("[Tray] Loaded icon from WPF resource");
                    }
                }
                catch (Exception ex)
                {
                    Logger.Debug($"[Tray] Could not load WPF resource: {ex.Message}");
                }
            }

            // Fallback to system icon
            _notifyIcon.Icon = trayIcon ?? SystemIcons.Application;
            if (trayIcon == null)
            {
                Logger.Warn("[Tray] Using fallback system icon - icon.ico not found");
            }

            // Double-click opens main window
            _notifyIcon.DoubleClick += (s, e) => App.Instance.ShowMainWindow();

            Logger.Info("[Tray] System tray initialized");
        }

        private void OnOpenClick(object? sender, EventArgs e)
        {
            App.Instance.ShowMainWindow();
        }

        private async void OnRestartClick(object? sender, EventArgs e)
        {
            Logger.Info("Restarting all servers...");

            var servers = App.Instance.ServerManager.Servers;
            foreach (var userId in servers.Keys.ToList())
            {
                await App.Instance.ServerManager.RestartServerAsync(userId);
            }

            ShowBalloon("Servers Restarted", "All servers have been restarted.");
        }

        private void OnExitClick(object? sender, EventArgs e)
        {
            App.Instance.ExitApplication();
        }

        private void OnDebugModeClick(object? sender, EventArgs e)
        {
            var newValue = _debugModeItem?.Checked ?? false;
            SetDebugMode(newValue);
            Logger.Info($"Debug mode set to: {newValue}");
            ShowBalloon("Debug Mode", newValue ? "Debug mode enabled" : "Debug mode disabled");
        }

        private void OnOpenLogClick(object? sender, EventArgs e)
        {
            var logFile = Path.Combine(App.UserDataDirectory, "logs", "server.log");
            if (File.Exists(logFile))
            {
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = logFile,
                        UseShellExecute = true
                    });
                }
                catch (Exception ex)
                {
                    Logger.Error($"Failed to open log file: {ex.Message}");
                }
            }
            else
            {
                ShowBalloon("Log File", "Server log file not found", ToolTipIcon.Warning);
            }
        }

        private bool GetDebugMode()
        {
            try
            {
                var settingsPath = Path.Combine(App.UserDataDirectory, "settings", "settings.json");
                if (File.Exists(settingsPath))
                {
                    var json = File.ReadAllText(settingsPath);
                    using var doc = JsonDocument.Parse(json);
                    if (doc.RootElement.TryGetProperty("debugMode", out var debugProp))
                    {
                        return debugProp.GetBoolean();
                    }
                }
            }
            catch (Exception ex)
            {
                Logger.Debug($"Could not read debug mode: {ex.Message}");
            }
            return false;
        }

        private void SetDebugMode(bool enabled)
        {
            try
            {
                var settingsPath = Path.Combine(App.UserDataDirectory, "settings", "settings.json");
                var settingsDir = Path.GetDirectoryName(settingsPath)!;
                Directory.CreateDirectory(settingsDir);

                // Read existing settings or create new
                Dictionary<string, object> settings;
                if (File.Exists(settingsPath))
                {
                    var json = File.ReadAllText(settingsPath);
                    settings = JsonSerializer.Deserialize<Dictionary<string, object>>(json) ?? new();
                }
                else
                {
                    settings = new Dictionary<string, object>
                    {
                        { "port", 12345 },
                        { "host", "127.0.0.1" },
                        { "logLevel", "info" }
                    };
                }

                settings["debugMode"] = enabled;

                var options = new JsonSerializerOptions { WriteIndented = true };
                File.WriteAllText(settingsPath, JsonSerializer.Serialize(settings, options));
            }
            catch (Exception ex)
            {
                Logger.Error($"Failed to save debug mode: {ex.Message}");
            }
        }

        public void ShowBalloon(string title, string message, ToolTipIcon icon = ToolTipIcon.Info)
        {
            _notifyIcon?.ShowBalloonTip(3000, title, message, icon);
        }

        public void Dispose()
        {
            if (_notifyIcon != null)
            {
                _notifyIcon.Visible = false;
                _notifyIcon.Dispose();
                _notifyIcon = null;
            }

            _contextMenu?.Dispose();
            _contextMenu = null;
        }
    }
}
