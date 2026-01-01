using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

namespace ShippingManagerCoPilot.Launcher
{
    public class ServerManager
    {
        private readonly Dictionary<string, ServerInstance> _servers = new();

        // HTTP client for health checks (ignore SSL errors for self-signed cert)
        private static readonly HttpClient _httpClient = new(new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = (_, _, _, _) => true
        })
        {
            Timeout = TimeSpan.FromSeconds(5)
        };

        public IReadOnlyDictionary<string, ServerInstance> Servers => _servers;

        public async Task StartAllServersAsync(List<SessionInfo> sessions)
        {
            foreach (var session in sessions)
            {
                if (!session.Autostart)
                {
                    continue;
                }

                // Port comes from session (read from DB)
                await StartServerAsync(session, session.Port);
            }
        }

        public async Task StartServerAsync(SessionInfo session, int port)
        {
            try
            {
                ProcessStartInfo startInfo;

                if (App.IsPackaged)
                {
                    // Packaged mode: use the SEA executable
                    var serverPath = Path.Combine(App.AppDirectory, "ShippingManagerCoPilot-Server.exe");

                    if (!File.Exists(serverPath))
                    {
                        Logger.Error($"Server executable not found: {serverPath}");
                        return;
                    }

                    Logger.Info($"Starting server for {session.CompanyName} on port {port}...");

                    startInfo = new ProcessStartInfo
                    {
                        FileName = serverPath,
                        WorkingDirectory = App.AppDirectory,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = false,
                        RedirectStandardError = false
                    };
                }
                else
                {
                    // Development mode: use node app.js from project root
                    var projectRoot = FindProjectRoot();
                    if (projectRoot == null)
                    {
                        Logger.Error("Could not find project root (app.js)");
                        return;
                    }

                    var appJsPath = Path.Combine(projectRoot, "app.js");
                    if (!File.Exists(appJsPath))
                    {
                        Logger.Error($"app.js not found at: {appJsPath}");
                        return;
                    }

                    Logger.Info($"Starting server for {session.CompanyName} on port {port}...");

                    startInfo = new ProcessStartInfo
                    {
                        FileName = "node",
                        Arguments = "app.js",
                        WorkingDirectory = projectRoot,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = false,
                        RedirectStandardError = false
                    };
                }

                // Pass only session selection (NOT port or cookie - app reads from accounts.db)
                startInfo.EnvironmentVariables["HOST"] = "127.0.0.1";
                startInfo.EnvironmentVariables["SELECTED_USER_ID"] = session.UserId;

                var process = Process.Start(startInfo);

                if (process == null)
                {
                    Logger.Error($"Failed to start server for {session.CompanyName}");
                    return;
                }

                _servers[session.UserId] = new ServerInstance
                {
                    Process = process,
                    Port = port,
                    Session = session
                };

                // Wait a bit to check if process started successfully
                await Task.Delay(500);

                if (process.HasExited)
                {
                    Logger.Error($"Server for {session.CompanyName} exited immediately (code {process.ExitCode})");
                    _servers.Remove(session.UserId);
                    return;
                }

                Logger.Info($"Server process for {session.CompanyName} started, waiting for health endpoint...");

                // Wait for server to be ready by polling /health endpoint
                var isReady = await WaitForServerReadyAsync(port, 90000);

                if (isReady)
                {
                    var serverInfo = _servers.GetValueOrDefault(session.UserId);
                    if (serverInfo != null)
                    {
                        serverInfo.Ready = true;
                    }
                    Logger.Info($"Server for {session.CompanyName} is READY (port {port})");
                }
                else
                {
                    Logger.Warn($"Server for {session.CompanyName} startup timeout - continuing anyway");
                }
            }
            catch (Exception ex)
            {
                Logger.Error($"Failed to start server for {session.CompanyName}: {ex.Message}");
            }
        }

        /// <summary>
        /// Wait for server to be ready by polling /health endpoint
        /// </summary>
        /// <param name="port">Port number</param>
        /// <param name="timeoutMs">Timeout in milliseconds</param>
        /// <returns>True if server is ready, false if timeout</returns>
        private async Task<bool> WaitForServerReadyAsync(int port, int timeoutMs = 60000)
        {
            var startTime = DateTime.Now;
            var url = $"https://127.0.0.1:{port}/health";

            while ((DateTime.Now - startTime).TotalMilliseconds < timeoutMs)
            {
                try
                {
                    var response = await _httpClient.GetAsync(url);
                    if (response.IsSuccessStatusCode)
                    {
                        var content = await response.Content.ReadAsStringAsync();
                        var health = JsonSerializer.Deserialize<HealthResponse>(content);

                        if (health?.ready == true)
                        {
                            Logger.Info($"Server ready on port {port}");
                            return true;
                        }

                        Logger.Debug($"Server not ready yet (ready: {health?.ready})");
                    }
                }
                catch
                {
                    // Server not responding yet, keep trying
                }

                await Task.Delay(1000);
            }

            Logger.Error($"Server startup timeout after {timeoutMs}ms");
            return false;
        }

        private class HealthResponse
        {
            public bool ready { get; set; }
        }

        /// <summary>
        /// Find project root by searching for app.js upwards from current directory
        /// </summary>
        private static string? FindProjectRoot()
        {
            var searchDir = App.AppDirectory;

            // Search up to 6 levels up to find app.js
            for (int i = 0; i < 6; i++)
            {
                var appJsPath = Path.Combine(searchDir, "app.js");
                if (File.Exists(appJsPath))
                {
                    return searchDir;
                }

                var parent = Directory.GetParent(searchDir);
                if (parent == null) break;
                searchDir = parent.FullName;
            }

            return null;
        }

        public async Task StopServerAsync(string userId)
        {
            if (!_servers.TryGetValue(userId, out var instance))
            {
                return;
            }

            try
            {
                Logger.Info($"Stopping server for {instance.Session.CompanyName}...");

                if (!instance.Process.HasExited)
                {
                    instance.Process.Kill();
                    await instance.Process.WaitForExitAsync();
                }

                _servers.Remove(userId);
                Logger.Info($"Server for {instance.Session.CompanyName} stopped");
            }
            catch (Exception ex)
            {
                Logger.Error($"Failed to stop server: {ex.Message}");
            }
        }

        public async Task RestartServerAsync(string userId)
        {
            if (!_servers.TryGetValue(userId, out var instance))
            {
                return;
            }

            var port = instance.Port;
            var session = instance.Session;

            await StopServerAsync(userId);

            // Reload session to get updated cookie
            var sessions = await App.Instance.SessionManager.GetAvailableSessionsAsync();
            var updatedSession = sessions.FirstOrDefault(s => s.UserId == userId);

            if (updatedSession != null)
            {
                await StartServerAsync(updatedSession, port);
            }
        }

        public void StopAllServers()
        {
            Logger.Info($"Stopping {_servers.Count} server(s)...");

            foreach (var kvp in _servers.ToList())
            {
                try
                {
                    if (!kvp.Value.Process.HasExited)
                    {
                        kvp.Value.Process.Kill();
                    }
                }
                catch (Exception ex)
                {
                    Logger.Error($"Error stopping server {kvp.Key}: {ex.Message}");
                }
            }

            _servers.Clear();
        }

        public string? GetServerUrl(string userId)
        {
            if (_servers.TryGetValue(userId, out var instance))
            {
                return $"https://localhost:{instance.Port}";
            }
            return null;
        }
    }

    public class ServerInstance
    {
        public Process Process { get; set; } = null!;
        public int Port { get; set; }
        public SessionInfo Session { get; set; } = null!;
        public bool Ready { get; set; } = false;
    }
}
