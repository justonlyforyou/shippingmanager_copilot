using System;
using System.Data.SQLite;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Web;

namespace ShippingManagerCoPilot.Launcher
{
    public class SteamExtractionResult
    {
        public string? Cookie { get; set; }
        public string? Error { get; set; }
        public bool Success => Cookie != null;
    }

    public static class SteamCookieExtractor
    {
        private const string TargetDomain = "shippingmanager.cc";
        private const string TargetCookieName = "shipping_manager_session";

        public static async Task<SteamExtractionResult> ExtractCookieAsync()
        {
            try
            {
                Logger.Info("[Steam] Starting cookie extraction...");

                var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                var steamBase = Path.Combine(localAppData, "Steam", "htmlcache");

                // Find cookies database (try multiple paths)
                var cookiesPath = FindFile(new[]
                {
                    Path.Combine(steamBase, "Default", "Network", "Cookies"),
                    Path.Combine(steamBase, "Network", "Cookies"),
                    Path.Combine(steamBase, "Cookies"),
                });

                if (cookiesPath == null)
                {
                    var error = "Steam cookies database not found. Please login to Shipping Manager via Steam browser first.";
                    Logger.Error($"[Steam] {error}");
                    return new SteamExtractionResult { Error = error };
                }

                Logger.Debug($"[Steam] Found cookies at: {cookiesPath}");

                // Find Local State file (contains AES key)
                var localStatePath = FindFile(new[]
                {
                    Path.Combine(steamBase, "Local State"),
                    Path.Combine(steamBase, "Default", "LocalPrefs.json"),
                    Path.Combine(steamBase, "LocalPrefs.json"),
                });

                if (localStatePath == null)
                {
                    var error = "Steam Local State file not found (needed for decryption).";
                    Logger.Error($"[Steam] {error}");
                    return new SteamExtractionResult { Error = error };
                }

                Logger.Debug($"[Steam] Found Local State at: {localStatePath}");

                // Kill Steam FIRST before reading any files
                var steamExePath = GetSteamExePath();
                var steamWasRunning = IsSteamRunning();

                if (steamWasRunning)
                {
                    Logger.Info("[Steam] Killing Steam to access files...");
                    KillSteam();
                    await Task.Delay(2000); // Wait for Steam to fully exit
                }

                string? cookie = null;
                string? extractError = null;
                try
                {
                    // Get AES key from Local State
                    var aesKey = GetAesKey(localStatePath);
                    if (aesKey == null)
                    {
                        extractError = "Failed to extract AES decryption key from Steam.";
                        Logger.Error($"[Steam] {extractError}");
                    }
                    else
                    {
                        cookie = await ExtractFromDatabaseAsync(cookiesPath, aesKey);
                        if (cookie == null)
                        {
                            extractError = "No Shipping Manager session found in Steam cookies. Please login via Steam browser first.";
                        }
                    }
                }
                catch (Exception ex)
                {
                    extractError = $"Database access failed: {ex.Message}";
                    Logger.Error($"[Steam] {extractError}");
                }
                finally
                {
                    if (steamWasRunning && steamExePath != null)
                    {
                        Logger.Info("[Steam] Restarting Steam...");
                        StartSteam(steamExePath);
                    }
                }

                if (cookie != null)
                {
                    return new SteamExtractionResult { Cookie = cookie };
                }
                return new SteamExtractionResult { Error = extractError };
            }
            catch (Exception ex)
            {
                var error = $"Steam extraction failed: {ex.Message}";
                Logger.Error($"[Steam] {error}");
                return new SteamExtractionResult { Error = error };
            }
        }

        private static bool IsSteamRunning()
        {
            return Process.GetProcessesByName("steam").Length > 0;
        }

        private static void KillSteam()
        {
            foreach (var process in Process.GetProcessesByName("steam"))
            {
                try
                {
                    process.Kill();
                    process.WaitForExit(5000);
                }
                catch { }
            }
        }

        private static string? GetSteamExePath()
        {
            // Check common Steam paths
            var paths = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam", "steam.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Steam", "steam.exe"),
                @"C:\Steam\steam.exe",
                @"D:\Steam\steam.exe",
            };

            foreach (var path in paths)
            {
                if (File.Exists(path))
                {
                    return path;
                }
            }

            return null;
        }

        private static void StartSteam(string steamExePath)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = steamExePath,
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                Logger.Error($"[Steam] Failed to restart Steam: {ex.Message}");
            }
        }

        private static string? FindFile(string[] paths)
        {
            foreach (var path in paths)
            {
                if (File.Exists(path))
                {
                    return path;
                }
            }
            return null;
        }

        private static byte[]? GetAesKey(string localStatePath)
        {
            try
            {
                var json = File.ReadAllText(localStatePath);
                using var doc = JsonDocument.Parse(json);

                if (!doc.RootElement.TryGetProperty("os_crypt", out var osCrypt) ||
                    !osCrypt.TryGetProperty("encrypted_key", out var encryptedKeyElement))
                {
                    Logger.Error("[Steam] os_crypt.encrypted_key not found in Local State");
                    return null;
                }

                var encryptedKeyB64 = encryptedKeyElement.GetString();
                if (string.IsNullOrEmpty(encryptedKeyB64))
                {
                    return null;
                }

                var encryptedKey = Convert.FromBase64String(encryptedKeyB64);

                // Remove "DPAPI" prefix (first 5 bytes)
                var keyWithoutPrefix = new byte[encryptedKey.Length - 5];
                Array.Copy(encryptedKey, 5, keyWithoutPrefix, 0, keyWithoutPrefix.Length);

                // Decrypt with DPAPI
                var decryptedKey = ProtectedData.Unprotect(keyWithoutPrefix, null, DataProtectionScope.CurrentUser);

                Logger.Debug($"[Steam] AES key extracted ({decryptedKey.Length} bytes)");
                return decryptedKey;
            }
            catch (Exception ex)
            {
                Logger.Error($"[Steam] Failed to get AES key: {ex.Message}");
                return null;
            }
        }

        private static async Task<string?> ExtractFromDatabaseAsync(string dbPath, byte[] aesKey)
        {
            var connectionString = $"Data Source={dbPath};Version=3;Read Only=True;";

            using var connection = new SQLiteConnection(connectionString);
            await connection.OpenAsync();

            var query = @"
                SELECT name, encrypted_value
                FROM cookies
                WHERE host_key LIKE @domain";

            using var command = new SQLiteCommand(query, connection);
            command.Parameters.AddWithValue("@domain", $"%{TargetDomain}");

            using var reader = await command.ExecuteReaderAsync();

            while (await reader.ReadAsync())
            {
                var name = reader.GetString(0);
                if (name != TargetCookieName)
                {
                    continue;
                }

                if (reader.IsDBNull(1))
                {
                    continue;
                }

                var encryptedValue = (byte[])reader.GetValue(1);
                if (encryptedValue.Length == 0)
                {
                    continue;
                }

                var decrypted = DecryptAesGcm(encryptedValue, aesKey);
                if (!string.IsNullOrEmpty(decrypted))
                {
                    var cookie = HttpUtility.UrlDecode(decrypted).Trim();
                    Logger.Info($"[Steam] Cookie extracted and decrypted ({cookie.Length} chars)");
                    return cookie;
                }
            }

            Logger.Warn("[Steam] No matching cookie found in database");
            return null;
        }

        private static string? DecryptAesGcm(byte[] encryptedValue, byte[] aesKey)
        {
            try
            {
                // Check for v10/v11 prefix
                if (encryptedValue.Length < 3)
                {
                    return null;
                }

                var prefix = Encoding.ASCII.GetString(encryptedValue, 0, 3);
                if (prefix != "v10" && prefix != "v11")
                {
                    // Try DPAPI fallback for older format
                    try
                    {
                        var decrypted = ProtectedData.Unprotect(encryptedValue, null, DataProtectionScope.CurrentUser);
                        return Encoding.UTF8.GetString(decrypted);
                    }
                    catch
                    {
                        return null;
                    }
                }

                // v10/v11 AES-GCM encryption
                // Format: "v10" + nonce(12) + ciphertext + tag(16)
                var dataWithoutPrefix = encryptedValue.Skip(3).ToArray();

                if (dataWithoutPrefix.Length < 12 + 16)
                {
                    return null;
                }

                var nonce = dataWithoutPrefix.Take(12).ToArray();
                var ciphertextWithTag = dataWithoutPrefix.Skip(12).ToArray();
                var tag = ciphertextWithTag.Skip(ciphertextWithTag.Length - 16).ToArray();
                var ciphertext = ciphertextWithTag.Take(ciphertextWithTag.Length - 16).ToArray();

                // Decrypt using AES-GCM
                using var aesGcm = new AesGcm(aesKey, 16);
                var plaintext = new byte[ciphertext.Length];
                aesGcm.Decrypt(nonce, ciphertext, tag, plaintext);

                return Encoding.UTF8.GetString(plaintext);
            }
            catch (Exception ex)
            {
                Logger.Debug($"[Steam] AES-GCM decryption failed: {ex.Message}");
                return null;
            }
        }
    }
}
