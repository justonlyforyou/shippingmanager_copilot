using System;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json.Linq;

namespace BrowserLogin
{
    /// <summary>
    /// Browser login window with WebView2 and cookie extraction
    /// </summary>
    public partial class BrowserLoginWindow : Window
    {
        private readonly string _targetUrl;
        private readonly int _timeoutSeconds;
        private readonly DispatcherTimer _pollingTimer;
        private readonly DispatcherTimer _countdownTimer;
        private readonly HttpClient _httpClient;
        private int _remainingSeconds;
        private bool _loginSuccessful = false;
        private string? _sessionCookie = null;

        public BrowserLoginWindow(string url, int timeoutSeconds)
        {
            InitializeComponent();

            _targetUrl = url;
            _timeoutSeconds = timeoutSeconds;
            _remainingSeconds = timeoutSeconds;

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
                // Initialize WebView2 with custom user data folder (use TEMP to avoid polluting repo)
                var userDataFolder = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "BrowserLogin_WebView2");
                var env = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
                await BrowserView.EnsureCoreWebView2Async(env);

                // Configure WebView2
                BrowserView.CoreWebView2.Settings.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
                BrowserView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                BrowserView.CoreWebView2.Settings.AreDevToolsEnabled = false;

                // Navigate to target URL
                BrowserView.Source = new Uri(_targetUrl);

                // Start timers
                _pollingTimer.Start();
                _countdownTimer.Start();

                UpdateStatusText("Browser ready. Please login...");
            }
            catch (Exception ex)
            {
                ShowError($"Failed to initialize browser: {ex.Message}");
                ExitWithCode(3);
            }
        }

        private async Task CheckForSessionCookie()
        {
            try
            {
                // Get all cookies for shippingmanager.cc domain (including subdomains)
                var allCookies = await BrowserView.CoreWebView2.CookieManager.GetCookiesAsync(null);

                // Filter for shipping_manager_session cookie on any shippingmanager.cc domain
                foreach (var cookie in allCookies)
                {
                    if (cookie.Name == "shipping_manager_session" &&
                        (cookie.Domain.Contains("shippingmanager.cc") || cookie.Domain.Contains(".shippingmanager.cc")))
                    {
                        string cookieValue = cookie.Value;

                        // Validate cookie with API
                        ProgressText.Text = "Validating session cookie...";
                        bool isValid = await ValidateSessionCookie(cookieValue);

                        if (isValid)
                        {
                            _sessionCookie = cookieValue;
                            await OnLoginSuccess();
                            return;
                        }
                        else
                        {
                            ProgressText.Text = "Invalid session cookie, waiting for valid login...";
                        }
                    }
                }

                ProgressText.Text = $"Checking for session cookie... ({_pollingTimer.Interval.TotalSeconds}s interval)";
            }
            catch (Exception ex)
            {
                // Don't fail on polling errors, just log
                ProgressText.Text = $"Polling error: {ex.Message}";
            }
        }

        private async Task<bool> ValidateSessionCookie(string cookieValue)
        {
            try
            {
                var request = new HttpRequestMessage(HttpMethod.Get, "https://shippingmanager.cc/api/user/get-user-settings");
                request.Headers.Add("Cookie", $"shipping_manager_session={cookieValue}");

                var response = await _httpClient.SendAsync(request);

                if (!response.IsSuccessStatusCode)
                {
                    return false;
                }

                var content = await response.Content.ReadAsStringAsync();
                var json = JObject.Parse(content);

                // Check if response contains settings (valid session)
                if (json["data"]?["settings"] != null)
                {
                    return true;
                }

                return false;
            }
            catch
            {
                return false;
            }
        }

        private async Task OnLoginSuccess()
        {
            _loginSuccessful = true;
            _pollingTimer.Stop();
            _countdownTimer.Stop();

            // Update UI
            UpdateStatusText("Login successful! Session validated.");
            StatusIndicator.Fill = (SolidColorBrush)FindResource("SuccessColor");
            FooterStatusText.Text = "Authentication successful!";
            FooterStatusText.Foreground = (SolidColorBrush)FindResource("SuccessColor");
            ProgressText.Text = "Session cookie extracted and validated";

            // Show success overlay
            SuccessOverlay.Visibility = Visibility.Visible;

            // Wait 1.5 seconds to show success message
            await Task.Delay(1500);

            // Output cookie to stdout
            Console.WriteLine(_sessionCookie);

            // Exit with success code
            ExitWithCode(0);
        }

        private void CountdownTimer_Tick(object? sender, EventArgs e)
        {
            _remainingSeconds--;

            // Update timer display
            int minutes = _remainingSeconds / 60;
            int seconds = _remainingSeconds % 60;
            TimerText.Text = $"{minutes}:{seconds:D2}";

            // Check for timeout
            if (_remainingSeconds <= 0)
            {
                OnTimeout();
            }
            else if (_remainingSeconds <= 30)
            {
                // Warning color for last 30 seconds
                TimerText.Foreground = (SolidColorBrush)FindResource("WarningColor");
            }
            else if (_remainingSeconds <= 10)
            {
                // Error color for last 10 seconds
                TimerText.Foreground = (SolidColorBrush)FindResource("ErrorColor");
            }
        }

        private void OnTimeout()
        {
            _pollingTimer.Stop();
            _countdownTimer.Stop();

            UpdateStatusText("Login timeout - no valid session found");
            StatusIndicator.Fill = (SolidColorBrush)FindResource("ErrorColor");
            FooterStatusText.Text = "Timeout reached";
            FooterStatusText.Foreground = (SolidColorBrush)FindResource("ErrorColor");

            MessageBox.Show(
                $"Login timeout after {_timeoutSeconds} seconds.\n\nNo valid session cookie was found.",
                "Login Timeout",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);

            ExitWithCode(1);
        }

        private void CancelButton_Click(object sender, RoutedEventArgs e)
        {
            if (!_loginSuccessful)
            {
                var result = MessageBox.Show(
                    "Are you sure you want to cancel the login?",
                    "Cancel Login",
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Question);

                if (result == MessageBoxResult.Yes)
                {
                    ExitWithCode(2);
                }
            }
        }

        private void BrowserLoginWindow_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
        {
            // If closing without success, exit with cancelled code
            if (!_loginSuccessful)
            {
                ExitWithCode(2);
            }
        }

        private void UpdateStatusText(string message)
        {
            StatusText.Text = message;
        }

        private void ShowError(string message)
        {
            Console.Error.WriteLine($"ERROR: {message}");
            MessageBox.Show(message, "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }

        private void ExitWithCode(int exitCode)
        {
            _pollingTimer?.Stop();
            _countdownTimer?.Stop();
            _httpClient?.Dispose();

            Application.Current.Shutdown(exitCode);
        }
    }
}
