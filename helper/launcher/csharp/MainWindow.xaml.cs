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

        public void RefreshSessions()
        {
            var sessions = new List<SessionViewModel>();

            foreach (var kvp in App.Instance.ServerManager.Servers)
            {
                var instance = kvp.Value;
                var isSteam = instance.Session.LoginMethod == "steam";
                var autostart = instance.Session.Autostart;

                sessions.Add(new SessionViewModel
                {
                    UserId = instance.Session.UserId,
                    CompanyName = instance.Session.CompanyName,
                    LoginMethod = instance.Session.LoginMethod,
                    Port = instance.Port,
                    Url = $"https://localhost:{instance.Port}",
                    Icon = isSteam ? "\uE7FC" : "\uE774",
                    IconColor = isSteam ? new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x66, 0xc0, 0xf4)) : new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x3b, 0x82, 0xf6)),
                    Autostart = autostart,
                    AutostartText = autostart ? "Auto" : "Off",
                    AutostartTooltip = autostart ? "Autostart enabled - click to disable" : "Autostart disabled - click to enable"
                });
            }

            SessionsList.ItemsSource = sessions;
            ServerCountText.Text = $"{sessions.Count} server(s) running";
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
                var newValue = await App.Instance.SessionManager.ToggleAutostartAsync(userId);

                // Update the server instance
                if (App.Instance.ServerManager.Servers.TryGetValue(userId, out var instance))
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
                var url = $"https://localhost:{kvp.Value.Port}";
                OpenUrl(url);
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
    }
}
