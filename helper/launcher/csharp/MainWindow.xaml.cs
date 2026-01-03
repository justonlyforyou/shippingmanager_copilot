using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace ShippingManagerCoPilot.Launcher
{
    public partial class MainWindow : Window
    {
        public MainWindow()
        {
            InitializeComponent();
            Closing += MainWindow_Closing;

            // Set userdata path
            UserdataPathText.Text = $"Userdata: {App.UserDataDirectory}";
        }

        private void MainWindow_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
        {
            // Don't close, just hide (minimize to tray)
            e.Cancel = true;
            Hide();
        }

        private List<SessionViewModel> _pendingSessions = new();

        public void RefreshSessions()
        {
            var sessions = new List<SessionViewModel>();

            // Add running servers
            foreach (var kvp in App.Instance.ServerManager.Servers)
            {
                var instance = kvp.Value;
                var isSteam = instance.Session.LoginMethod == "steam";
                var autostart = instance.Session.Autostart;

                // Only show as ready if actually ready
                var status = instance.Ready ? "ready" : "loading";

                sessions.Add(new SessionViewModel
                {
                    UserId = instance.Session.UserId,
                    CompanyName = instance.Session.CompanyName,
                    LoginMethod = instance.Session.LoginMethod,
                    Port = instance.Port,
                    Url = instance.Session.Url,
                    Icon = isSteam ? "\U0001F3AE" : "\U0001F310",  // 🎮 or 🌐 emoji
                    IconColor = isSteam ? new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x66, 0xc0, 0xf4)) : new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x3b, 0x82, 0xf6)),
                    Autostart = autostart,
                    AutostartText = autostart ? "Autostart On" : "Autostart Off",
                    AutostartTooltip = autostart ? "Autostart enabled - click to disable" : "Autostart disabled - click to enable",
                    Status = status
                });
            }

            // Add pending sessions (still loading)
            foreach (var pending in _pendingSessions)
            {
                // Skip if already in running servers
                if (sessions.Any(s => s.UserId == pending.UserId))
                    continue;

                sessions.Add(pending);
            }

            SessionsList.ItemsSource = sessions;
            UpdateStatusDisplay(sessions);
        }

        private void UpdateStatusDisplay(List<SessionViewModel> sessions)
        {
            var readyCount = sessions.Count(s => s.IsReady);
            var totalCount = sessions.Count;
            var loadingCount = sessions.Count(s => s.IsLoading);

            // Update progress bar
            if (totalCount > 0)
            {
                var progressPercent = (double)readyCount / totalCount;
                ProgressBarFill.Width = progressPercent * 400; // 400 is the container width
            }
            else
            {
                ProgressBarFill.Width = 0;
            }

            if (loadingCount > 0)
            {
                TitleText.Text = "Starting...";
                ServerCountText.Text = $"{readyCount} of {totalCount} server(s) ready";
            }
            else if (readyCount > 0)
            {
                TitleText.Text = "Server Ready!";
                TitleText.Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x22, 0xc5, 0x5e)); // SuccessColor
                ServerCountText.Text = $"{readyCount} server(s) running";
            }
            else
            {
                TitleText.Text = "Startup Failed";
                TitleText.Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0xdc, 0x26, 0x26)); // DangerColor
                ServerCountText.Text = "No servers could be started";
            }
        }

        public void SetPendingSessions(List<SessionViewModel> pending)
        {
            _pendingSessions = pending;
            RefreshSessions();
        }

        public void UpdateSessionStatus(string userId, string status, string? error = null)
        {
            var pending = _pendingSessions.FirstOrDefault(s => s.UserId == userId);
            if (pending != null)
            {
                pending.Status = status;
                pending.ErrorMessage = error;

                // If ready, remove from pending (will be picked up from ServerManager)
                if (status == "ready")
                {
                    _pendingSessions.Remove(pending);
                }
            }

            // Refresh on UI thread
            Dispatcher.Invoke(RefreshSessions);
        }

        private void SessionItem_Click(object sender, MouseButtonEventArgs e)
        {
            if (sender is FrameworkElement element && element.Tag is string userId)
            {
                var url = App.Instance.ServerManager.GetServerUrl(userId);
                if (!string.IsNullOrEmpty(url))
                {
                    OpenUrl(url);
                }
            }
        }

        private async void ToggleAutostart_Click(object sender, RoutedEventArgs e)
        {
            if (sender is WpfButton button && button.Tag is string userId)
            {
                // Get current value and toggle it
                bool currentValue = true;
                if (App.Instance.ServerManager.Servers.TryGetValue(userId, out var instance))
                {
                    currentValue = instance.Session.Autostart;
                }
                else
                {
                    var account = App.Instance.SessionManager.GetAccount(userId);
                    if (account != null)
                    {
                        currentValue = account.Autostart;
                    }
                }

                var newValue = !currentValue;
                await App.Instance.SessionManager.SetAutostartAsync(userId, newValue);

                // Update the server instance
                if (instance != null)
                {
                    instance.Session.Autostart = newValue;
                }

                RefreshSessions();
            }
        }

        private async void RefreshSession_Click(object sender, RoutedEventArgs e)
        {
            if (sender is WpfButton btn && btn.Tag is string userId)
            {
                await App.Instance.RefreshAccountAsync(userId);
            }
        }

        private async void DeleteSession_Click(object sender, RoutedEventArgs e)
        {
            if (sender is WpfButton deleteBtn && deleteBtn.Tag is string userId)
            {
                var result = WpfMessageBox.Show(
                    "Are you sure you want to remove this account?",
                    "Remove Account",
                    WpfMessageBoxButton.YesNo,
                    WpfMessageBoxImage.Question
                );

                if (result == WpfMessageBoxResult.Yes)
                {
                    await App.Instance.RemoveAccountAsync(userId);
                }
            }
        }

        private async void AddAccount_Click(object sender, RoutedEventArgs e)
        {
            await App.Instance.AddAccountAsync();
        }

        private void OpenAll_Click(object sender, RoutedEventArgs e)
        {
            foreach (var kvp in App.Instance.ServerManager.Servers)
            {
                OpenUrl(kvp.Value.Session.Url);
            }
        }

        private void Minimize_Click(object sender, RoutedEventArgs e)
        {
            Hide();
            App.Instance.TrayIcon.ShowBalloon(
                "ShippingManager CoPilot",
                "Running in background. Double-click tray icon to open."
            );
        }

        private void OpenUrl(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                Logger.Error($"Failed to open URL: {ex.Message}");
            }
        }
    }

    public class SessionViewModel
    {
        public string UserId { get; set; } = "";
        public string CompanyName { get; set; } = "";
        public string LoginMethod { get; set; } = "";
        public int Port { get; set; }
        public string Url { get; set; } = "";
        public string Icon { get; set; } = "";
        public System.Windows.Media.Brush IconColor { get; set; } = System.Windows.Media.Brushes.White;
        public bool Autostart { get; set; } = true;
        public string AutostartText { get; set; } = "Auto";
        public string AutostartTooltip { get; set; } = "";

        // Loading state support
        public string Status { get; set; } = "ready"; // loading, ready, error
        public string? ErrorMessage { get; set; }
        public bool IsLoading => Status == "loading";
        public bool IsReady => Status == "ready";
        public bool IsError => Status == "error";
        public Visibility LoadingVisibility => IsLoading ? Visibility.Visible : Visibility.Collapsed;
        public Visibility ReadyVisibility => IsReady ? Visibility.Visible : Visibility.Collapsed;
        public Visibility ErrorVisibility => IsError ? Visibility.Visible : Visibility.Collapsed;
        public string StatusText => IsLoading ? "Starting..." : (IsError ? (ErrorMessage ?? "Error") : Url);
    }
}
