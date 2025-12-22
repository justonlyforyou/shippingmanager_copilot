using System;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace ShippingManagerCoPilot.Launcher
{
    /// <summary>
    /// Windows Credential Manager wrapper - compatible with Node.js keytar
    /// Uses CredEnumerate like keytar's findCredentials for reliability
    /// </summary>
    public static class CredentialManager
    {
        private const string SERVICE_NAME = "ShippingManagerCoPilot";
        private const int CRED_TYPE_GENERIC = 1;
        private const int CRED_PERSIST_LOCAL_MACHINE = 2;

        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredDelete(string target, int type, int flags);

        [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
        private static extern bool CredFree([In] IntPtr cred);

        [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredEnumerate(string? filter, uint flags, out uint count, out IntPtr credentials);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct CREDENTIAL
        {
            public uint Flags;
            public uint Type;
            public IntPtr TargetName;
            public IntPtr Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            public IntPtr TargetAlias;
            public IntPtr UserName;
        }

        private static string GetTargetName(string accountName)
        {
            return $"{SERVICE_NAME}/{accountName}";
        }

        public static bool SetPassword(string accountName, string password)
        {
            try
            {
                var targetName = GetTargetName(accountName);
                var passwordBytes = Encoding.UTF8.GetBytes(password);
                var targetNamePtr = Marshal.StringToHGlobalUni(targetName);
                var userNamePtr = Marshal.StringToHGlobalUni(accountName);
                var blobPtr = Marshal.AllocHGlobal(passwordBytes.Length);

                try
                {
                    Marshal.Copy(passwordBytes, 0, blobPtr, passwordBytes.Length);

                    var credential = new CREDENTIAL
                    {
                        Type = CRED_TYPE_GENERIC,
                        TargetName = targetNamePtr,
                        CredentialBlobSize = (uint)passwordBytes.Length,
                        CredentialBlob = blobPtr,
                        Persist = CRED_PERSIST_LOCAL_MACHINE,
                        UserName = userNamePtr
                    };

                    var result = CredWrite(ref credential, 0);

                    if (!result)
                    {
                        var error = Marshal.GetLastWin32Error();
                        Logger.Error($"[CredentialManager] CredWrite failed with error {error}");
                        return false;
                    }

                    return true;
                }
                finally
                {
                    Marshal.FreeHGlobal(targetNamePtr);
                    Marshal.FreeHGlobal(userNamePtr);
                    Marshal.FreeHGlobal(blobPtr);
                }
            }
            catch (Exception ex)
            {
                Logger.Error($"[CredentialManager] SetPassword error: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Retrieve password using CredEnumerate (like keytar's findCredentials)
        /// </summary>
        public static string? GetPassword(string accountName)
        {
            var targetName = GetTargetName(accountName);
            Logger.Debug($"[CredentialManager] Looking for credential: {targetName}");

            try
            {
                // Enumerate all credentials for our service
                var filter = $"{SERVICE_NAME}*";
                Logger.Debug($"[CredentialManager] Enumerating with filter: {filter}");

                if (!CredEnumerate(filter, 0, out uint count, out IntPtr credentialsPtr))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != 1168) // ERROR_NOT_FOUND
                    {
                        Logger.Error($"[CredentialManager] CredEnumerate failed with error {error}");
                    }
                    else
                    {
                        Logger.Debug($"[CredentialManager] No credentials found matching filter: {filter}");
                    }
                    return null;
                }

                Logger.Debug($"[CredentialManager] Found {count} credential(s) matching filter");

                try
                {
                    for (int i = 0; i < count; i++)
                    {
                        var credPtr = Marshal.ReadIntPtr(credentialsPtr, i * IntPtr.Size);
                        var cred = Marshal.PtrToStructure<CREDENTIAL>(credPtr);

                        var credTargetName = Marshal.PtrToStringUni(cred.TargetName);
                        Logger.Debug($"[CredentialManager] Checking credential [{i}]: {credTargetName}");

                        if (credTargetName == targetName)
                        {
                            if (cred.CredentialBlobSize == 0 || cred.CredentialBlob == IntPtr.Zero)
                            {
                                Logger.Error($"[CredentialManager] Empty credential blob for {targetName}");
                                return null;
                            }

                            var passwordBytes = new byte[cred.CredentialBlobSize];
                            Marshal.Copy(cred.CredentialBlob, passwordBytes, 0, (int)cred.CredentialBlobSize);

                            Logger.Debug($"[CredentialManager] Raw bytes: {cred.CredentialBlobSize} bytes, first 10: [{string.Join(",", passwordBytes.Take(10).Select(b => $"0x{b:X2}"))}]");

                            // Check for Python keyring UTF-16 issue (null bytes between chars)
                            // UTF-16 LE pattern: [char, 0x00, char, 0x00, ...]
                            bool isUtf16 = passwordBytes.Length > 2 &&
                                           passwordBytes[1] == 0x00 &&
                                           passwordBytes[3] == 0x00 &&
                                           passwordBytes[0] != 0x00;

                            string password;
                            if (isUtf16)
                            {
                                Logger.Debug("[CredentialManager] Detected UTF-16 LE encoding, converting...");
                                // UTF-16 LE encoded - take every other byte
                                var sb = new StringBuilder();
                                for (int j = 0; j < passwordBytes.Length; j += 2)
                                {
                                    if (passwordBytes[j] != 0)
                                    {
                                        sb.Append((char)passwordBytes[j]);
                                    }
                                }
                                password = sb.ToString();
                            }
                            else
                            {
                                // UTF-8 encoded
                                password = Encoding.UTF8.GetString(passwordBytes);
                            }

                            Logger.Debug($"[CredentialManager] Decoded password: {password.Length} chars, starts with: {password.Substring(0, Math.Min(20, password.Length))}...");
                            return password;
                        }
                    }

                    return null;
                }
                finally
                {
                    CredFree(credentialsPtr);
                }
            }
            catch (Exception ex)
            {
                Logger.Error($"[CredentialManager] GetPassword error: {ex.Message}");
                return null;
            }
        }

        public static bool DeletePassword(string accountName)
        {
            try
            {
                var targetName = GetTargetName(accountName);
                var result = CredDelete(targetName, CRED_TYPE_GENERIC, 0);

                if (!result)
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != 1168)
                    {
                        Logger.Error($"[CredentialManager] CredDelete failed with error {error}");
                    }
                }

                return result;
            }
            catch (Exception ex)
            {
                Logger.Error($"[CredentialManager] DeletePassword error: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Migrate old format credentials to new keytar-compatible format.
        /// Old format: TargetName = "ShippingManagerCoPilot", UserName = "session_XXXXX"
        /// New format: TargetName = "ShippingManagerCoPilot/session_XXXXX", UserName = "session_XXXXX"
        /// </summary>
        public static void MigrateOldCredentials()
        {
            Logger.Info("[CredentialManager] Checking for old format credentials to migrate...");

            try
            {
                var filter = $"{SERVICE_NAME}*";
                if (!CredEnumerate(filter, 0, out uint count, out IntPtr credentialsPtr))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error == 1168) // ERROR_NOT_FOUND
                    {
                        Logger.Debug("[CredentialManager] No credentials found");
                    }
                    return;
                }

                try
                {
                    // First pass: collect old format entries and check for new format
                    var oldFormatEntries = new System.Collections.Generic.List<(string UserName, byte[] Blob, bool NewFormatExists)>();
                    var newFormatTargets = new System.Collections.Generic.HashSet<string>();

                    // Collect all new format targets first
                    for (int i = 0; i < count; i++)
                    {
                        var credPtr = Marshal.ReadIntPtr(credentialsPtr, i * IntPtr.Size);
                        var cred = Marshal.PtrToStructure<CREDENTIAL>(credPtr);
                        var credTargetName = Marshal.PtrToStringUni(cred.TargetName);

                        if (credTargetName != null && credTargetName.StartsWith($"{SERVICE_NAME}/"))
                        {
                            newFormatTargets.Add(credTargetName);
                        }
                    }

                    // Now find old format entries
                    for (int i = 0; i < count; i++)
                    {
                        var credPtr = Marshal.ReadIntPtr(credentialsPtr, i * IntPtr.Size);
                        var cred = Marshal.PtrToStructure<CREDENTIAL>(credPtr);
                        var credTargetName = Marshal.PtrToStringUni(cred.TargetName);
                        var credUserName = Marshal.PtrToStringUni(cred.UserName);

                        // Old format: TargetName is exactly SERVICE_NAME (no slash)
                        if (credTargetName == SERVICE_NAME && !string.IsNullOrEmpty(credUserName))
                        {
                            Logger.Info($"[CredentialManager] Found old format credential: Target={credTargetName}, User={credUserName}");

                            var newTargetName = $"{SERVICE_NAME}/{credUserName}";
                            var newFormatExists = newFormatTargets.Contains(newTargetName);

                            if (cred.CredentialBlobSize > 0 && cred.CredentialBlob != IntPtr.Zero)
                            {
                                var blob = new byte[cred.CredentialBlobSize];
                                Marshal.Copy(cred.CredentialBlob, blob, 0, (int)cred.CredentialBlobSize);
                                oldFormatEntries.Add((credUserName, blob, newFormatExists));
                            }
                        }
                    }

                    // Process old format entries
                    foreach (var (userName, blob, newFormatExists) in oldFormatEntries)
                    {
                        if (newFormatExists)
                        {
                            // New format exists - just delete old
                            Logger.Info($"[CredentialManager] New format exists for {userName}, deleting old format...");
                            DeleteOldFormatCredential(userName);
                        }
                        else
                        {
                            // Migrate: create new format, then delete old
                            Logger.Info($"[CredentialManager] Migrating {userName} to new format...");

                            // Decode password (handle UTF-16)
                            string password;
                            bool isUtf16 = blob.Length > 2 && blob[1] == 0x00 && blob[3] == 0x00 && blob[0] != 0x00;
                            if (isUtf16)
                            {
                                var sb = new StringBuilder();
                                for (int j = 0; j < blob.Length; j += 2)
                                {
                                    if (blob[j] != 0) sb.Append((char)blob[j]);
                                }
                                password = sb.ToString();
                                Logger.Info($"[CredentialManager] Converted UTF-16 to UTF-8 ({blob.Length} -> {password.Length} chars)");
                            }
                            else
                            {
                                password = Encoding.UTF8.GetString(blob);
                            }

                            // Save in new format
                            if (SetPassword(userName, password))
                            {
                                Logger.Info($"[CredentialManager] Saved in new format: {SERVICE_NAME}/{userName}");
                                // Delete old format
                                DeleteOldFormatCredential(userName);
                            }
                            else
                            {
                                Logger.Error($"[CredentialManager] Failed to save in new format for {userName}");
                            }
                        }
                    }

                    if (oldFormatEntries.Count == 0)
                    {
                        Logger.Debug("[CredentialManager] No old format credentials found");
                    }
                    else
                    {
                        Logger.Info($"[CredentialManager] Migration complete: processed {oldFormatEntries.Count} old format credential(s)");
                    }
                }
                finally
                {
                    CredFree(credentialsPtr);
                }
            }
            catch (Exception ex)
            {
                Logger.Error($"[CredentialManager] Migration error: {ex.Message}");
            }
        }

        /// <summary>
        /// Delete old format credential (TargetName = SERVICE_NAME exactly)
        /// </summary>
        private static bool DeleteOldFormatCredential(string userName)
        {
            try
            {
                // Old format has TargetName = SERVICE_NAME (no slash)
                var result = CredDelete(SERVICE_NAME, CRED_TYPE_GENERIC, 0);
                if (result)
                {
                    Logger.Info($"[CredentialManager] Deleted old format credential for {userName}");
                }
                else
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != 1168)
                    {
                        Logger.Error($"[CredentialManager] Failed to delete old format: error {error}");
                    }
                }
                return result;
            }
            catch (Exception ex)
            {
                Logger.Error($"[CredentialManager] DeleteOldFormatCredential error: {ex.Message}");
                return false;
            }
        }
    }
}
