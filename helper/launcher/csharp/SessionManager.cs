using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace ShippingManagerCoPilot.Launcher
{
    public class SessionManager
    {
        private const string KEYRING_PREFIX = "KEYRING:";

        private static readonly HttpClient _httpClient = new()
        {
            Timeout = TimeSpan.FromSeconds(10)
        };

        private string SessionsFilePath => Path.Combine(App.UserDataDirectory, "settings", "sessions.json");

        public async Task<List<SessionInfo>> GetAvailableSessionsAsync()
        {
            var sessions = new List<SessionInfo>();

            try
            {
                Logger.Info($"[SessionManager] Looking for sessions at: {SessionsFilePath}");

                if (!File.Exists(SessionsFilePath))
                {
                    Logger.Warn($"[SessionManager] Sessions file not found!");
                    return sessions;
                }

                Logger.Info($"[SessionManager] Sessions file found");

                var json = await File.ReadAllTextAsync(SessionsFilePath);
                var data = JsonConvert.DeserializeObject<Dictionary<string, SessionData>>(json);

                if (data == null)
                {
                    return sessions;
                }

                foreach (var kvp in data)
                {
                    var userId = kvp.Key;
                    var sessionData = kvp.Value;

                    // Decrypt cookie from Credential Manager (keytar-compatible)
                    var cookie = DecryptCookie(sessionData.Cookie, userId);
                    if (string.IsNullOrEmpty(cookie))
                    {
                        Logger.Warn($"[SessionManager] Could not decrypt cookie for {userId}");
                        continue;
                    }

                    // Validate session
                    Logger.Debug($"Validating session for {sessionData.CompanyName} ({userId})...");
                    var validation = await ValidateSessionCookieAsync(cookie);
                    if (validation != null)
                    {
                        Logger.Info($"Valid session: {sessionData.CompanyName} ({userId})");
                        sessions.Add(new SessionInfo
                        {
                            UserId = userId,
                            CompanyName = sessionData.CompanyName ?? validation.CompanyName,
                            Cookie = cookie,
                            LoginMethod = sessionData.LoginMethod ?? "unknown",
                            Autostart = sessionData.Autostart
                        });
                    }
                    else
                    {
                        Logger.Warn($"[SessionManager] Session invalid for {userId}");
                    }
                }
            }
            catch (Exception ex)
            {
                Logger.Error($"Failed to load sessions: {ex.Message}");
            }

            return sessions;
        }

        public async Task<SessionInfo?> ValidateSessionCookieAsync(string cookie)
        {
            try
            {
                var request = new HttpRequestMessage(HttpMethod.Get, "https://shippingmanager.cc/api/user/get-user-settings");
                request.Headers.Add("Cookie", $"shipping_manager_session={cookie}");
                request.Headers.Add("Accept", "application/json");

                var response = await _httpClient.SendAsync(request);

                if (!response.IsSuccessStatusCode)
                {
                    return null;
                }

                var content = await response.Content.ReadAsStringAsync();
                var json = JObject.Parse(content);

                var user = json["user"];
                if (user == null)
                {
                    return null;
                }

                var userId = user["id"]?.ToString();
                if (string.IsNullOrEmpty(userId))
                {
                    return null;
                }

                var companyName = user["company_name"]?.ToString() ?? user["name"]?.ToString() ?? "Unknown";

                return new SessionInfo
                {
                    UserId = userId,
                    CompanyName = companyName,
                    Cookie = cookie
                };
            }
            catch (Exception ex)
            {
                Logger.Error($"Session validation failed: {ex.Message}");
                return null;
            }
        }

        public async Task SaveSessionAsync(string userId, string cookie, string companyName, string loginMethod)
        {
            try
            {
                Dictionary<string, SessionData> data;

                if (File.Exists(SessionsFilePath))
                {
                    var json = await File.ReadAllTextAsync(SessionsFilePath);
                    data = JsonConvert.DeserializeObject<Dictionary<string, SessionData>>(json) ?? new();
                }
                else
                {
                    data = new();
                }

                // Store cookie in Credential Manager (keytar-compatible)
                var accountName = $"session_{userId}";
                if (!CredentialManager.SetPassword(accountName, cookie))
                {
                    throw new Exception("Failed to store cookie in Credential Manager");
                }

                // Store reference in sessions.json (keytar format)
                data[userId] = new SessionData
                {
                    Cookie = $"{KEYRING_PREFIX}{accountName}",
                    CompanyName = companyName,
                    LoginMethod = loginMethod,
                    Autostart = true,
                    LastUpdated = DateTime.UtcNow.ToString("o")
                };

                var outputJson = JsonConvert.SerializeObject(data, Formatting.Indented);

                // Ensure directory exists
                Directory.CreateDirectory(Path.GetDirectoryName(SessionsFilePath)!);
                await File.WriteAllTextAsync(SessionsFilePath, outputJson);

                Logger.Info($"Session saved for {companyName} ({userId})");
            }
            catch (Exception ex)
            {
                Logger.Error($"Failed to save session: {ex.Message}");
                throw;
            }
        }

        public async Task DeleteSessionAsync(string userId)
        {
            try
            {
                // Delete from Credential Manager
                var accountName = $"session_{userId}";
                CredentialManager.DeletePassword(accountName);

                // Remove from sessions.json
                if (!File.Exists(SessionsFilePath))
                {
                    return;
                }

                var json = await File.ReadAllTextAsync(SessionsFilePath);
                var data = JsonConvert.DeserializeObject<Dictionary<string, SessionData>>(json);

                if (data == null || !data.ContainsKey(userId))
                {
                    return;
                }

                data.Remove(userId);

                var outputJson = JsonConvert.SerializeObject(data, Formatting.Indented);
                await File.WriteAllTextAsync(SessionsFilePath, outputJson);

                Logger.Info($"Session deleted for {userId}");
            }
            catch (Exception ex)
            {
                Logger.Error($"Failed to delete session: {ex.Message}");
            }
        }

        public async Task<bool> ToggleAutostartAsync(string userId)
        {
            try
            {
                if (!File.Exists(SessionsFilePath))
                {
                    return false;
                }

                var json = await File.ReadAllTextAsync(SessionsFilePath);
                var data = JsonConvert.DeserializeObject<Dictionary<string, SessionData>>(json);

                if (data == null || !data.ContainsKey(userId))
                {
                    return false;
                }

                // Toggle autostart
                data[userId].Autostart = !data[userId].Autostart;
                var newValue = data[userId].Autostart;

                var outputJson = JsonConvert.SerializeObject(data, Formatting.Indented);
                await File.WriteAllTextAsync(SessionsFilePath, outputJson);

                Logger.Info($"Autostart for {userId} set to {newValue}");
                return newValue;
            }
            catch (Exception ex)
            {
                Logger.Error($"Failed to toggle autostart: {ex.Message}");
                return false;
            }
        }

        private string? DecryptCookie(string? cookieRef, string userId)
        {
            if (string.IsNullOrEmpty(cookieRef))
            {
                return null;
            }

            // Check if it's a keyring reference
            if (cookieRef.StartsWith(KEYRING_PREFIX))
            {
                var accountName = cookieRef.Substring(KEYRING_PREFIX.Length);
                Logger.Debug($"[SessionManager] Looking up credential: {accountName}");
                var password = CredentialManager.GetPassword(accountName);
                Logger.Info($"[SessionManager] Credential lookup for {accountName}: {(password != null ? "FOUND" : "NOT FOUND")}");
                return password;
            }

            // Legacy: might be plain text (old format) - should not happen
            Logger.Warn($"[SessionManager] Found non-keyring cookie for {userId}");
            return cookieRef;
        }

        private class SessionData
        {
            [JsonProperty("cookie")]
            public string? Cookie { get; set; }

            [JsonProperty("company_name")]
            public string? CompanyName { get; set; }

            [JsonProperty("login_method")]
            public string? LoginMethod { get; set; }

            [JsonProperty("autostart")]
            public bool Autostart { get; set; } = true;

            [JsonProperty("last_updated")]
            public string? LastUpdated { get; set; }
        }
    }
}
