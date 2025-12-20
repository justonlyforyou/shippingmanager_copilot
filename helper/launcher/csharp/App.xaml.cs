using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace ShippingManagerCoPilot.Launcher
{
    public partial class App : WpfApplication
    {
        private TrayIconManager? _trayIcon;
        private ServerManager? _serverManager;
        private SessionManager? _sessionManager;
        private MainWindow? _mainWindow;

        public static App Instance => (App)Current;
        public TrayIconManager TrayIcon => _trayIcon!;
        public ServerManager ServerManager => _serverManager!;
        public SessionManager SessionManager => _sessionManager!;

        public static string AppDirectory => AppDomain.CurrentDomain.BaseDirectory;

        /// <summary>
        /// Check if running as installed (in Program Files) or development mode
        /// </summary>
        public static bool IsPackaged
        {
            get
            {
                // Installed = running from Program Files
                var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                var programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);

                return AppDirectory.StartsWith(programFiles, StringComparison.OrdinalIgnoreCase) ||
                       AppDirectory.StartsWith(programFilesX86, StringComparison.OrdinalIgnoreCase);
            }
        }

        /// <summary>
        /// User data directory - LocalAppData for installed, project folder for development
        /// </summary>
        public static string UserDataDirectory
        {
            get
            {
                if (IsPackaged)
                {
                    // Installed: ONLY LocalAppData
                    return Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "ShippingManagerCoPilot",
                        "userdata"
                    );
                }

                // Development: find project's userdata folder
                var searchRoot = AppDirectory;
                for (int i = 0; i < 6; i++)
                {
                    var testPath = Path.Combine(searchRoot, "userdata");
                    if (Directory.Exists(testPath))
                    {
                        return testPath;
                    }
                    var parent = Directory.GetParent(searchRoot);
                    if (parent == null) break;
                    searchRoot = parent.FullName;
                }

                throw new InvalidOperationException($"Development mode: userdata folder not found starting from {AppDirectory}");
            }
        }

        private void Application_Startup(object sender, System.Windows.StartupEventArgs e)
        {
            // Log paths for debugging
            Logger.Info($"[App] AppDirectory: {AppDirectory}");
            Logger.Info($"[App] IsPackaged: {IsPackaged}");
            Logger.Info($"[App] UserDataDirectory: {UserDataDirectory}");

            // Ensure userdata directory exists
            Directory.CreateDirectory(UserDataDirectory);
            Directory.CreateDirectory(Path.Combine(UserDataDirectory, "settings"));
            Directory.CreateDirectory(Path.Combine(UserDataDirectory, "logs"));

            // Initialize managers
            _sessionManager = new SessionManager();
            _serverManager = new ServerManager();
            _trayIcon = new TrayIconManager();

            // Initialize tray icon
            _trayIcon.Initialize();

            // Start the main flow
            StartApplication();
        }

        private async void StartApplication()
        {
            try
            {
                // Load existing sessions
                var sessions = await _sessionManager!.GetAvailableSessionsAsync();

                if (sessions.Count == 0)
                {
                    // No sessions - show login dialog
                    Logger.Info("No sessions found, showing login dialog...");
                    var loginResult = await ShowLoginMethodDialogAsync();

                    if (loginResult == null)
                    {
                        // User cancelled
                        Logger.Info("Login cancelled, exiting...");
                        Shutdown();
                        return;
                    }

                    // Reload sessions after login
                    sessions = await _sessionManager.GetAvailableSessionsAsync();

                    if (sessions.Count == 0)
                    {
                        Logger.Error("No sessions after login attempt");
                        WpfMessageBox.Show(
                            "Failed to add account. Please try again.",
                            "ShippingManager CoPilot",
                            WpfMessageBoxButton.OK,
                            WpfMessageBoxImage.Error
                        );
                        Shutdown();
                        return;
                    }
                }

                // Start servers for all sessions
                Logger.Info($"Starting {sessions.Count} server(s)...");
                await _serverManager!.StartAllServersAsync(sessions);

                // Show main window
                ShowMainWindow();
            }
            catch (Exception ex)
            {
                Logger.Error($"Startup error: {ex.Message}");
                WpfMessageBox.Show(
                    $"Failed to start: {ex.Message}",
                    "ShippingManager CoPilot",
                    WpfMessageBoxButton.OK,
                    WpfMessageBoxImage.Error
                );
                Shutdown();
            }
        }

        public async Task<SessionInfo?> ShowLoginMethodDialogAsync()
        {
            var dialog = new LoginMethodDialog();
            dialog.Owner = _mainWindow;

            if (dialog.ShowDialog() == true)
            {
                if (dialog.SelectedMethod == LoginMethod.Steam)
                {
                    return await DoSteamLoginAsync();
                }
                else
                {
                    return await DoBrowserLoginAsync();
                }
            }

            return null;
        }

        private async Task<SessionInfo?> DoSteamLoginAsync()
        {
            try
            {
                Logger.Info("Attempting Steam cookie extraction...");
                var result = await SteamCookieExtractor.ExtractCookieAsync();

                if (!result.Success)
                {
                    WpfMessageBox.Show(
                        result.Error ?? "Unknown error during Steam extraction.",
                        "Steam Extraction Failed",
                        WpfMessageBoxButton.OK,
                        WpfMessageBoxImage.Warning
                    );
                    return null;
                }

                // Validate and save session
                var validation = await _sessionManager!.ValidateSessionCookieAsync(result.Cookie!);
                if (validation != null)
                {
                    await _sessionManager.SaveSessionAsync(validation.UserId, result.Cookie!, validation.CompanyName, "steam");
                    Logger.Info($"Session saved for {validation.CompanyName}");

                    WpfMessageBox.Show(
                        $"Steam session for \"{validation.CompanyName}\" successfully extracted!",
                        "Steam Login Successful",
                        WpfMessageBoxButton.OK,
                        WpfMessageBoxImage.Information
                    );

                    return validation;
                }
                else
                {
                    WpfMessageBox.Show(
                        "Cookie extracted but session validation failed. The session may have expired.",
                        "Validation Failed",
                        WpfMessageBoxButton.OK,
                        WpfMessageBoxImage.Warning
                    );
                    return null;
                }
            }
            catch (Exception ex)
            {
                Logger.Error($"Steam login error: {ex.Message}");
                WpfMessageBox.Show(
                    $"Steam extraction error: {ex.Message}",
                    "Error",
                    WpfMessageBoxButton.OK,
                    WpfMessageBoxImage.Error
                );
                return null;
            }
        }

        private async Task<SessionInfo?> DoBrowserLoginAsync()
        {
            try
            {
                Logger.Info("Starting browser login...");
                var loginWindow = new BrowserLoginWindow();

                if (loginWindow.ShowDialog() == true && !string.IsNullOrEmpty(loginWindow.SessionCookie))
                {
                    var cookie = loginWindow.SessionCookie;

                    // Validate and save session
                    var validation = await _sessionManager!.ValidateSessionCookieAsync(cookie);
                    if (validation != null)
                    {
                        await _sessionManager.SaveSessionAsync(validation.UserId, cookie, validation.CompanyName, "browser");
                        Logger.Info($"Session saved for {validation.CompanyName}");
                        return validation;
                    }
                    else
                    {
                        WpfMessageBox.Show(
                            "Could not validate browser session. Please try again.",
                            "Validation Failed",
                            WpfMessageBoxButton.OK,
                            WpfMessageBoxImage.Warning
                        );
                        return null;
                    }
                }

                return null;
            }
            catch (Exception ex)
            {
                Logger.Error($"Browser login error: {ex.Message}");
                WpfMessageBox.Show(
                    $"Browser login error: {ex.Message}",
                    "Error",
                    WpfMessageBoxButton.OK,
                    WpfMessageBoxImage.Error
                );
                return null;
            }
        }

        public void ShowMainWindow()
        {
            if (_mainWindow == null)
            {
                _mainWindow = new MainWindow();
            }

            _mainWindow.RefreshSessions();
            _mainWindow.Show();
            _mainWindow.Activate();
        }

        public void HideMainWindow()
        {
            _mainWindow?.Hide();
        }

        public async Task AddAccountAsync()
        {
            var session = await ShowLoginMethodDialogAsync();
            if (session != null)
            {
                // Start server for new session
                var port = _serverManager!.GetNextPort();
                await _serverManager.StartServerAsync(session, port);

                // Refresh main window
                _mainWindow?.RefreshSessions();
            }
        }

        public async Task RemoveAccountAsync(string userId)
        {
            // Stop server
            await _serverManager!.StopServerAsync(userId);

            // Delete session
            await _sessionManager!.DeleteSessionAsync(userId);

            // Refresh main window
            _mainWindow?.RefreshSessions();
        }

        public async Task RefreshAccountAsync(string userId)
        {
            var sessions = await _sessionManager!.GetAvailableSessionsAsync();
            var session = sessions.FirstOrDefault(s => s.UserId == userId);

            if (session != null)
            {
                SessionInfo? newSession = null;

                if (session.LoginMethod == "steam")
                {
                    newSession = await DoSteamLoginAsync();
                }
                else
                {
                    newSession = await DoBrowserLoginAsync();
                }

                if (newSession != null)
                {
                    // Restart server
                    await _serverManager!.RestartServerAsync(userId);
                    _mainWindow?.RefreshSessions();
                }
            }
        }

        public void ExitApplication()
        {
            Logger.Info("Shutting down...");

            // Stop all servers
            _serverManager?.StopAllServers();

            // Dispose tray icon
            _trayIcon?.Dispose();

            // Shutdown
            Shutdown();
        }

        protected override void OnExit(System.Windows.ExitEventArgs e)
        {
            _trayIcon?.Dispose();
            base.OnExit(e);
        }
    }
}
