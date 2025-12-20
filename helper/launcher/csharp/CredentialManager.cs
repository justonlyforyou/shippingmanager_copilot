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

            try
            {
                // Enumerate all credentials for our service
                if (!CredEnumerate($"{SERVICE_NAME}*", 0, out uint count, out IntPtr credentialsPtr))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != 1168) // ERROR_NOT_FOUND
                    {
                        Logger.Error($"[CredentialManager] CredEnumerate failed with error {error}");
                    }
                    return null;
                }

                try
                {
                    for (int i = 0; i < count; i++)
                    {
                        var credPtr = Marshal.ReadIntPtr(credentialsPtr, i * IntPtr.Size);
                        var cred = Marshal.PtrToStructure<CREDENTIAL>(credPtr);

                        var credTargetName = Marshal.PtrToStringUni(cred.TargetName);

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
    }
}
