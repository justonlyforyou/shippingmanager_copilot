using System;
using System.Collections.Generic;
using System.Data.SQLite;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace ShippingManagerCoPilot.Launcher
{
    public class SessionManager
    {
        private const string KEYRING_PREFIX = "KEYRING:";
        private const int ACCOUNTS_DB_VERSION = 1;

        private static readonly HttpClient _httpClient = new()
        {
            Timeout = TimeSpan.FromSeconds(10)
        };

        /// <summary>
        /// Normalize a session cookie to consistent format (URL-decoded)
        /// Handles both URL-encoded (%3D) and raw cookies
        /// </summary>
        private static string NormalizeCookie(string cookie)
        {
            if (string.IsNullOrEmpty(cookie))
            {
                return cookie;
            }

            if (cookie.Contains("%"))
            {
                try
                {
                    var decoded = Uri.UnescapeDataString(cookie);
                    Logger.Debug($"[SessionManager] Cookie was URL-encoded, decoded from {cookie.Length} to {decoded.Length} chars");
                    return decoded;
                }
                catch
                {
                    Logger.Debug("[SessionManager] Cookie contains % but is not URL-encoded");
                    return cookie;
                }
            }

            return cookie;
        }

        private string AccountsDbPath => Path.Combine(App.UserDataDirectory, "database", "accounts.db");

        /// <summary>
        /// Ensures the accounts database exists and has the correct schema
        /// </summary>
        private void EnsureDatabase()
        {
            var dbDir = Path.GetDirectoryName(AccountsDbPath);
            if (!Directory.Exists(dbDir))
            {
                Directory.CreateDirectory(dbDir!);
            }

            if (!File.Exists(AccountsDbPath))
            {
                SQLiteConnection.CreateFile(AccountsDbPath);
            }

            using var connection = new SQLiteConnection($"Data Source={AccountsDbPath};Version=3;");
            connection.Open();

            // Create accounts table if not exists
            using var cmd = new SQLiteCommand(@"
                CREATE TABLE IF NOT EXISTS accounts (
                    user_id TEXT PRIMARY KEY,
                    company_name TEXT NOT NULL,
                    cookie TEXT NOT NULL,
                    login_method TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    autostart INTEGER DEFAULT 1,
                    timestamp INTEGER NOT NULL,
                    last_updated TEXT
                )", connection);
            cmd.ExecuteNonQuery();

            // Create meta table for version tracking
            using var metaCmd = new SQLiteCommand(@"
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )", connection);
            metaCmd.ExecuteNonQuery();
        }

        public async Task<List<SessionInfo>> GetAvailableSessionsAsync()
        {
            var sessions = new List<SessionInfo>();

            try
            {
                Logger.Info($"[SessionManager] Looking for accounts database at: {AccountsDbPath}");
                Logger.Info($"[SessionManager] UserDataDirectory: {App.UserDataDirectory}");
                Logger.Info($"[SessionManager] IsPackaged: {App.IsPackaged}");

                EnsureDatabase();

                if (!File.Exists(AccountsDbPath))
                {
                    Logger.Warn($"[SessionManager] Accounts database not found at: {AccountsDbPath}");
                    return sessions;
                }

                Logger.Info($"[SessionManager] Accounts database found");

                using var connection = new SQLiteConnection($"Data Source={AccountsDbPath};Version=3;");
                connection.Open();

                using var cmd = new SQLiteCommand(
                    "SELECT user_id, company_name, cookie, login_method, port, autostart, timestamp FROM accounts ORDER BY timestamp DESC",
                    connection);

                using var reader = cmd.ExecuteReader();

                while (reader.Read())
                {
                    var userId = reader.GetString(0);
                    var companyName = reader.GetString(1);
                    var cookieRef = reader.GetString(2);
                    var loginMethod = reader.GetString(3);
                    var port = reader.GetInt32(4);
                    var autostart = reader.GetInt32(5) == 1;

                    // Decrypt cookie from Credential Manager (keytar-compatible)
                    var cookie = DecryptCookie(cookieRef, userId);
                    if (string.IsNullOrEmpty(cookie))
                    {
                        Logger.Warn($"[SessionManager] Could not decrypt cookie for {userId}");
                        // Still add to list with valid=false so UI can show it
                        sessions.Add(new SessionInfo
                        {
                            UserId = userId,
                            CompanyName = companyName,
                            Cookie = null,
                            LoginMethod = loginMethod,
                            Port = port,
                            Autostart = autostart,
                            Valid = false,
                            Error = "Failed to decrypt session cookie"
                        });
                        continue;
                    }

                    // Validate session
                    Logger.Debug($"Validating session for {companyName} ({userId})...");
                    var validation = await ValidateSessionCookieAsync(cookie);
                    if (validation != null)
                    {
                        Logger.Info($"Valid session: {companyName} ({userId}) on port {port}");
                        sessions.Add(new SessionInfo
                        {
                            UserId = userId,
                            CompanyName = companyName,
                            Cookie = cookie,
                            LoginMethod = loginMethod,
                            Port = port,
                            Autostart = autostart,
                            Valid = true
                        });
                    }
                    else
                    {
                        Logger.Warn($"[SessionManager] Session invalid/expired for {userId}");
                        sessions.Add(new SessionInfo
                        {
                            UserId = userId,
                            CompanyName = companyName,
                            Cookie = cookie,
                            LoginMethod = loginMethod,
                            Port = port,
                            Autostart = autostart,
                            Valid = false,
                            Error = "Session expired or invalid"
                        });
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
                // Normalize cookie first (decode URL-encoded cookies)
                var normalizedCookie = NormalizeCookie(cookie);

                var request = new HttpRequestMessage(HttpMethod.Get, "https://shippingmanager.cc/api/user/get-user-settings");
                request.Headers.Add("Cookie", $"shipping_manager_session={normalizedCookie}");
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
                    Cookie = cookie,
                    Valid = true
                };
            }
            catch (Exception ex)
            {
                Logger.Error($"Session validation failed: {ex.Message}");
                return null;
            }
        }

        public Task SaveSessionAsync(string userId, string cookie, string companyName, string loginMethod)
        {
            return Task.Run(() =>
            {
                try
                {
                    EnsureDatabase();

                    // Normalize cookie (ensure consistent format - always URL-decoded)
                    var normalizedCookie = NormalizeCookie(cookie);

                    // Store cookie in Credential Manager (keytar-compatible)
                    var accountName = $"session_{userId}";
                    if (!CredentialManager.SetPassword(accountName, normalizedCookie))
                    {
                        throw new Exception("Failed to store cookie in Credential Manager");
                    }

                    using var connection = new SQLiteConnection($"Data Source={AccountsDbPath};Version=3;");
                    connection.Open();

                    // Check if account exists to preserve port/autostart
                    int port = 12345;
                    bool autostart = true;

                    using (var checkCmd = new SQLiteCommand(
                        "SELECT port, autostart FROM accounts WHERE user_id = @userId", connection))
                    {
                        checkCmd.Parameters.AddWithValue("@userId", userId);
                        using var reader = checkCmd.ExecuteReader();
                        if (reader.Read())
                        {
                            port = reader.GetInt32(0);
                            autostart = reader.GetInt32(1) == 1;
                        }
                        else
                        {
                            // Find next available port
                            port = FindNextAvailablePort(connection, 12345);
                        }
                    }

                    // Upsert account
                    using var cmd = new SQLiteCommand(@"
                        INSERT INTO accounts (user_id, company_name, cookie, login_method, port, autostart, timestamp, last_updated)
                        VALUES (@userId, @companyName, @cookie, @loginMethod, @port, @autostart, @timestamp, @lastUpdated)
                        ON CONFLICT(user_id) DO UPDATE SET
                            company_name = @companyName,
                            cookie = @cookie,
                            login_method = @loginMethod,
                            timestamp = @timestamp,
                            last_updated = @lastUpdated
                    ", connection);

                    cmd.Parameters.AddWithValue("@userId", userId);
                    cmd.Parameters.AddWithValue("@companyName", companyName);
                    cmd.Parameters.AddWithValue("@cookie", $"{KEYRING_PREFIX}{accountName}");
                    cmd.Parameters.AddWithValue("@loginMethod", loginMethod);
                    cmd.Parameters.AddWithValue("@port", port);
                    cmd.Parameters.AddWithValue("@autostart", autostart ? 1 : 0);
                    cmd.Parameters.AddWithValue("@timestamp", DateTimeOffset.UtcNow.ToUnixTimeSeconds());
                    cmd.Parameters.AddWithValue("@lastUpdated", DateTime.UtcNow.ToString("o"));

                    cmd.ExecuteNonQuery();

                    Logger.Info($"Session saved for {companyName} ({userId}) on port {port}");
                }
                catch (Exception ex)
                {
                    Logger.Error($"Failed to save session: {ex.Message}");
                    throw;
                }
            });
        }

        private int FindNextAvailablePort(SQLiteConnection connection, int basePort)
        {
            using var cmd = new SQLiteCommand(
                "SELECT port FROM accounts ORDER BY port", connection);

            var usedPorts = new HashSet<int>();
            using (var reader = cmd.ExecuteReader())
            {
                while (reader.Read())
                {
                    usedPorts.Add(reader.GetInt32(0));
                }
            }

            int port = basePort;
            while (usedPorts.Contains(port))
            {
                port++;
            }

            return port;
        }

        public Task DeleteSessionAsync(string userId)
        {
            return Task.Run(() =>
            {
                try
                {
                    // Delete from Credential Manager
                    var accountName = $"session_{userId}";
                    CredentialManager.DeletePassword(accountName);

                    if (!File.Exists(AccountsDbPath))
                    {
                        return;
                    }

                    using var connection = new SQLiteConnection($"Data Source={AccountsDbPath};Version=3;");
                    connection.Open();

                    using var cmd = new SQLiteCommand(
                        "DELETE FROM accounts WHERE user_id = @userId", connection);
                    cmd.Parameters.AddWithValue("@userId", userId);
                    cmd.ExecuteNonQuery();

                    Logger.Info($"Session deleted for {userId}");
                }
                catch (Exception ex)
                {
                    Logger.Error($"Failed to delete session: {ex.Message}");
                }
            });
        }

        public Task<bool> SetAutostartAsync(string userId, bool autostart)
        {
            return Task.Run(() =>
            {
                try
                {
                    if (!File.Exists(AccountsDbPath))
                    {
                        return false;
                    }

                    using var connection = new SQLiteConnection($"Data Source={AccountsDbPath};Version=3;");
                    connection.Open();

                    using var cmd = new SQLiteCommand(
                        "UPDATE accounts SET autostart = @autostart WHERE user_id = @userId", connection);
                    cmd.Parameters.AddWithValue("@userId", userId);
                    cmd.Parameters.AddWithValue("@autostart", autostart ? 1 : 0);

                    var affected = cmd.ExecuteNonQuery();
                    if (affected > 0)
                    {
                        Logger.Info($"Autostart for {userId} set to {autostart}");
                        return true;
                    }

                    return false;
                }
                catch (Exception ex)
                {
                    Logger.Error($"Failed to set autostart: {ex.Message}");
                    return false;
                }
            });
        }

        public Task<bool> SetPortAsync(string userId, int port)
        {
            return Task.Run(() =>
            {
                try
                {
                    if (!File.Exists(AccountsDbPath))
                    {
                        return false;
                    }

                    using var connection = new SQLiteConnection($"Data Source={AccountsDbPath};Version=3;");
                    connection.Open();

                    using var cmd = new SQLiteCommand(
                        "UPDATE accounts SET port = @port WHERE user_id = @userId", connection);
                    cmd.Parameters.AddWithValue("@userId", userId);
                    cmd.Parameters.AddWithValue("@port", port);

                    var affected = cmd.ExecuteNonQuery();
                    if (affected > 0)
                    {
                        Logger.Info($"Port for {userId} set to {port}");
                        return true;
                    }

                    return false;
                }
                catch (Exception ex)
                {
                    Logger.Error($"Failed to set port: {ex.Message}");
                    return false;
                }
            });
        }

        public SessionInfo? GetAccount(string userId)
        {
            try
            {
                if (!File.Exists(AccountsDbPath))
                {
                    return null;
                }

                using var connection = new SQLiteConnection($"Data Source={AccountsDbPath};Version=3;");
                connection.Open();

                using var cmd = new SQLiteCommand(
                    "SELECT user_id, company_name, cookie, login_method, port, autostart, timestamp FROM accounts WHERE user_id = @userId",
                    connection);
                cmd.Parameters.AddWithValue("@userId", userId);

                using var reader = cmd.ExecuteReader();
                if (reader.Read())
                {
                    var cookieRef = reader.GetString(2);
                    var cookie = DecryptCookie(cookieRef, userId);

                    return new SessionInfo
                    {
                        UserId = reader.GetString(0),
                        CompanyName = reader.GetString(1),
                        Cookie = cookie,
                        LoginMethod = reader.GetString(3),
                        Port = reader.GetInt32(4),
                        Autostart = reader.GetInt32(5) == 1,
                        Valid = cookie != null
                    };
                }

                return null;
            }
            catch (Exception ex)
            {
                Logger.Error($"Failed to get account: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Migrate sessions from old sessions.json to database
        /// </summary>
        public async Task<int> MigrateFromSessionsJsonAsync()
        {
            var sessionsJsonPath = Path.Combine(App.UserDataDirectory, "settings", "sessions.json");

            if (!File.Exists(sessionsJsonPath))
            {
                Logger.Debug("[SessionManager] No sessions.json found, migration not needed");
                return 0;
            }

            Logger.Info("[SessionManager] Found sessions.json, migrating to database...");
            EnsureDatabase();

            int migrated = 0;

            try
            {
                var json = await File.ReadAllTextAsync(sessionsJsonPath);
                var data = JsonConvert.DeserializeObject<Dictionary<string, LegacySessionData>>(json);

                if (data == null || data.Count == 0)
                {
                    Logger.Info("[SessionManager] sessions.json is empty, deleting file");
                    File.Delete(sessionsJsonPath);
                    return 0;
                }

                using var connection = new SQLiteConnection($"Data Source={AccountsDbPath};Version=3;");
                connection.Open();

                int portCounter = 12345;

                foreach (var kvp in data)
                {
                    var userId = kvp.Key;
                    var sessionData = kvp.Value;

                    // Check if already in database
                    using var checkCmd = new SQLiteCommand(
                        "SELECT user_id FROM accounts WHERE user_id = @userId", connection);
                    checkCmd.Parameters.AddWithValue("@userId", userId);
                    var existing = checkCmd.ExecuteScalar();

                    if (existing != null)
                    {
                        Logger.Debug($"[SessionManager] User {userId} already in database, skipping");
                        continue;
                    }

                    // Find next available port
                    int port = FindNextAvailablePort(connection, portCounter);
                    portCounter = port + 1;

                    // Insert into database
                    using var insertCmd = new SQLiteCommand(@"
                        INSERT INTO accounts (user_id, company_name, cookie, login_method, port, autostart, timestamp, last_updated)
                        VALUES (@userId, @companyName, @cookie, @loginMethod, @port, @autostart, @timestamp, @lastUpdated)
                    ", connection);

                    insertCmd.Parameters.AddWithValue("@userId", userId);
                    insertCmd.Parameters.AddWithValue("@companyName", sessionData.CompanyName ?? "Unknown");
                    insertCmd.Parameters.AddWithValue("@cookie", sessionData.Cookie ?? "");
                    insertCmd.Parameters.AddWithValue("@loginMethod", sessionData.LoginMethod ?? "unknown");
                    insertCmd.Parameters.AddWithValue("@port", port);
                    insertCmd.Parameters.AddWithValue("@autostart", sessionData.Autostart ? 1 : 0);
                    insertCmd.Parameters.AddWithValue("@timestamp", DateTimeOffset.UtcNow.ToUnixTimeSeconds());
                    insertCmd.Parameters.AddWithValue("@lastUpdated", DateTime.UtcNow.ToString("o"));

                    insertCmd.ExecuteNonQuery();
                    migrated++;

                    Logger.Info($"[SessionManager] Migrated {sessionData.CompanyName} ({userId}) to port {port}");
                }

                // Delete sessions.json after successful migration
                File.Delete(sessionsJsonPath);
                Logger.Info($"[SessionManager] Migration complete: {migrated} sessions migrated, sessions.json deleted");
            }
            catch (Exception ex)
            {
                Logger.Error($"[SessionManager] Migration failed: {ex.Message}");
            }

            return migrated;
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

        private class LegacySessionData
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
