using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace ShippingManagerCoPilot.Launcher
{
    public class TrayIconManager : IDisposable
    {
        private NotifyIcon? _notifyIcon;
        private ContextMenuStrip? _contextMenu;

        public void Initialize()
        {
            // Create context menu
            _contextMenu = new ContextMenuStrip();
            _contextMenu.Items.Add("Open CoPilot", null, OnOpenClick);
            _contextMenu.Items.Add("-");
            _contextMenu.Items.Add("Restart Servers", null, OnRestartClick);
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
