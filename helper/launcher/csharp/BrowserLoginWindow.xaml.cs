using System;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json.Linq;
using WpfBrush = System.Windows.Media.Brush;
using WpfBrushes = System.Windows.Media.Brushes;

namespace ShippingManagerCoPilot.Launcher
{
    public partial class BrowserLoginWindow : Window
    {
        private const string TargetUrl = "https://shippingmanager.cc";
        private const int TimeoutSeconds = 300; // 5 minutes

        private readonly DispatcherTimer _pollingTimer;
        private readonly DispatcherTimer _countdownTimer;
        private readonly HttpClient _httpClient;
        private int _remainingSeconds;

        public string? SessionCookie { get; private set; }

        public BrowserLoginWindow()
        {
            InitializeComponent();

            _remainingSeconds = TimeoutSeconds;

            _httpClient = new HttpClient
            {
                Timeout = TimeSpan.FromSeconds(10)
            };

            // Cookie polling timer (every 2 seconds)
            _pollingTimer = new DispatcherTimer
            {
                Interval = TimeSpan.FromSeconds(2)
            };
            _pollingTimer.Tick += async (s, e) => await CheckForSessionCookie();

            // Countdown timer (every second)
            _countdownTimer = new DispatcherTimer
            {
                Interval = TimeSpan.FromSeconds(1)
            };
            _countdownTimer.Tick += CountdownTimer_Tick;

            Loaded += BrowserLoginWindow_Loaded;
            Closing += BrowserLoginWindow_Closing;
        }

        private async void BrowserLoginWindow_Loaded(object sender, RoutedEventArgs e)
        {
            try
            {
                // Initialize WebView2 with custom user data folder
                var userDataFolder = Path.Combine(Path.GetTempPath(), "ShippingManagerCoPilot_WebView2");
                var env = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
                await BrowserView.EnsureCoreWebView2Async(env);

                // Configure WebView2
                BrowserView.CoreWebView2.Settings.UserAgent =
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
                BrowserView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                BrowserView.CoreWebView2.Settings.AreDevToolsEnabled = false;

                // Navigate to target URL
                BrowserView.Source = new Uri(TargetUrl);

                // Start timers
                _pollingTimer.Start();
                _countdownTimer.Start();

                UpdateStatus("Please login to Shipping Manager...");
            }
            catch (Exception ex)
            {
                Logger.Error($"[BrowserLogin] Failed to initialize WebView2: {ex.Message}");
                WpfMessageBox.Show(
                    $"Failed to initialize browser: {ex.Message}",
                    "Error",
                    WpfMessageBoxButton.OK,
                    WpfMessageBoxImage.Error
                );
                DialogResult = false;
                Close();
            }
        }

        private async Task CheckForSessionCookie()
        {
            try
            {
                // Get all cookies using WebView2 CookieManager (can access HttpOnly cookies!)
                var allCookies = await BrowserView.CoreWebView2.CookieManager.GetCookiesAsync(null);

                foreach (var cookie in allCookies)
                {
                    if (cookie.Name == "shipping_manager_session" &&
                        (cookie.Domain.Contains("shippingmanager.cc") || cookie.Domain.Contains(".shippingmanager.cc")))
                    {
                        Logger.Debug($"[BrowserLogin] Found session cookie ({cookie.Value.Length} chars)");

                        // Validate the cookie
                        var isValid = await ValidateCookieAsync(cookie.Value);
                        if (isValid)
                        {
                            SessionCookie = cookie.Value;

                            _pollingTimer.Stop();
                            _countdownTimer.Stop();

                            UpdateStatus("Login successful! Closing...", WpfBrushes.LimeGreen);
                            Logger.Info("[BrowserLogin] Login successful!");

                            // Wait a moment then close
                            await Task.Delay(1500);
                            DialogResult = true;
                            Close();
                            return;
                        }
                        else
                        {
                            Logger.Debug("[BrowserLogin] Cookie found but not valid yet...");
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Logger.Error($"[BrowserLogin] Error checking cookies: {ex.Message}");
            }
        }

        private async Task<bool> ValidateCookieAsync(string cookie)
        {
            try
            {
                var request = new HttpRequestMessage(HttpMethod.Get, "https://shippingmanager.cc/api/user/get-user-settings");
                request.Headers.Add("Cookie", $"shipping_manager_session={cookie}");
                request.Headers.Add("Accept", "application/json");

                var response = await _httpClient.SendAsync(request);

                if (!response.IsSuccessStatusCode)
                {
                    return false;
                }

                var content = await response.Content.ReadAsStringAsync();
                var json = JObject.Parse(content);

                var user = json["user"];
                if (user == null)
                {
                    return false;
                }

                var userId = user["id"]?.ToString();
                var companyName = user["company_name"]?.ToString() ?? user["name"]?.ToString();

                if (!string.IsNullOrEmpty(userId))
                {
                    Logger.Info($"[BrowserLogin] Session validated: {companyName} (ID: {userId})");
                    return true;
                }

                return false;
            }
            catch
            {
                return false;
            }
        }

        private void CountdownTimer_Tick(object? sender, EventArgs e)
        {
            _remainingSeconds--;

            var minutes = _remainingSeconds / 60;
            var seconds = _remainingSeconds % 60;
            CountdownText.Text = $"{minutes}:{seconds:D2}";

            // Change color as time runs out
            if (_remainingSeconds <= 30)
            {
                CountdownText.Foreground = WpfBrushes.Red;
            }
            else if (_remainingSeconds <= 60)
            {
                CountdownText.Foreground = WpfBrushes.Orange;
            }

            if (_remainingSeconds <= 0)
            {
                _pollingTimer.Stop();
                _countdownTimer.Stop();

                Logger.Warn("[BrowserLogin] Timeout - no valid cookie found");
                UpdateStatus("Timeout - please try again", WpfBrushes.Red);

                DialogResult = false;
                Close();
            }
        }

        private void UpdateStatus(string message, WpfBrush? color = null)
        {
            StatusText.Text = message;
            if (color != null)
            {
                StatusText.Foreground = color;
            }
        }

        private void Cancel_Click(object sender, RoutedEventArgs e)
        {
            _pollingTimer.Stop();
            _countdownTimer.Stop();
            DialogResult = false;
            Close();
        }

        private void BrowserLoginWindow_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
        {
            _pollingTimer.Stop();
            _countdownTimer.Stop();
            _httpClient.Dispose();
        }
    }
}
