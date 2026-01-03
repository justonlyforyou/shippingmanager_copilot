using System;
using System.IO;
using System.Linq;
using System.Text.Json;
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
        /// Check if running as installed (packaged) or development mode.
        /// Packaged = ShippingManagerCoPilot-Server.exe exists in app directory
        /// </summary>
        public static bool IsPackaged
        {
            get
            {
                // Check if Server.exe exists - definitive way to detect packaged mode
                var serverExe = Path.Combine(AppDirectory, "ShippingManagerCoPilot-Server.exe");
                return File.Exists(serverExe);
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

            // Migrate old format credentials to new keytar-compatible format
            CredentialManager.MigrateOldCredentials();

            // Initialize managers
            _sessionManager = new SessionManager();
            _serverManager = new ServerManager();
            _trayIcon = new TrayIconManager();

            // Migrate sessions.json to database if it exists
            _ = _sessionManager.MigrateFromSessionsJsonAsync();

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

                // Filter to autostart sessions
                var autostartSessions = sessions.Where(s => s.Autostart).ToList();

                if (autostartSessions.Count == 0)
                {
                    Logger.Error("No sessions to start");
                    WpfMessageBox.Show(
                        "No sessions found. Please add an account.",
                        "ShippingManager CoPilot",
                        WpfMessageBoxButton.OK,
                        WpfMessageBoxImage.Error
                    );
                    Shutdown();
                    return;
                }

                Logger.Info($"Starting {autostartSessions.Count} server(s) in parallel...");

                // Create pending session view models with loading state
                // Port comes from database (session.Port)
                var pendingSessions = autostartSessions.Select(session => new SessionViewModel
                {
                    UserId = session.UserId,
                    CompanyName = session.CompanyName,
                    LoginMethod = session.LoginMethod,
                    Port = session.Port,
                    Url = session.Url,
                    Icon = session.LoginMethod == "steam" ? "\U0001F3AE" : "\U0001F310",
                    IconColor = session.LoginMethod == "steam"
                        ? new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x66, 0xc0, 0xf4))
                        : new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x3b, 0x82, 0xf6)),
                    Autostart = session.Autostart,
                    AutostartText = session.Autostart ? "Autostart On" : "Autostart Off",
                    AutostartTooltip = session.Autostart ? "Autostart enabled - click to disable" : "Autostart disabled - click to enable",
                    Status = "loading"
                }).ToList();

                // Show main window immediately with loading state
                ShowMainWindowWithPendingSessions(pendingSessions);

                // Start all servers in parallel (fire and forget, update UI as each completes)
                // Port comes from session.Port (read from DB)
                foreach (var session in autostartSessions)
                {
                    _ = StartServerAndUpdateUIAsync(session, session.Port);
                }
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

        private async Task StartServerAndUpdateUIAsync(SessionInfo session, int port)
        {
            try
            {
                await _serverManager!.StartServerAsync(session, port);
                Logger.Info($"Server {session.CompanyName} is ready on port {port}");
                _mainWindow?.UpdateSessionStatus(session.UserId, "ready");
            }
            catch (Exception ex)
            {
                Logger.Error($"Failed to start {session.CompanyName}: {ex.Message}");
                _mainWindow?.UpdateSessionStatus(session.UserId, "error", ex.Message);
            }
        }

        public void ShowMainWindowWithPendingSessions(List<SessionViewModel> pendingSessions)
        {
            if (_mainWindow == null)
            {
                _mainWindow = new MainWindow();
            }

            _mainWindow.SetPendingSessions(pendingSessions);
            _mainWindow.Show();
            _mainWindow.Activate();
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
                // Reload session to get the port that was written to DB
                var sessions = await _sessionManager!.GetAvailableSessionsAsync();
                var savedSession = sessions.FirstOrDefault(s => s.UserId == session.UserId);

                if (savedSession != null)
                {
                    // Start server for new session - port comes from DB
                    await _serverManager!.StartServerAsync(savedSession, savedSession.Port);
                }

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
