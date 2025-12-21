using System;
using System.IO;

namespace ShippingManagerCoPilot.Launcher
{
    public static class Logger
    {
        private static readonly object _lock = new();
        private static string? _logFilePath;
        private static bool _initialized = false;

        private static string LogFilePath
        {
            get
            {
                if (_logFilePath == null)
                {
                    var logsDir = Path.Combine(App.UserDataDirectory, "logs");
                    Directory.CreateDirectory(logsDir);
                    _logFilePath = Path.Combine(logsDir, "launcher.log");
                }
                return _logFilePath;
            }
        }

        /// <summary>
        /// Initialize logger - clears the log file on first call
        /// </summary>
        private static void EnsureInitialized()
        {
            if (_initialized) return;
            _initialized = true;

            try
            {
                // Clear the log file on startup
                File.WriteAllText(LogFilePath, string.Empty);
            }
            catch
            {
                // Ignore errors during initialization
            }
        }

        public static void Log(string level, string message)
        {
            var timestamp = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss");
            var line = $"[{timestamp}] [{level.ToUpper()}] [Launcher] {message}";

            lock (_lock)
            {
                try
                {
                    EnsureInitialized();
                    File.AppendAllText(LogFilePath, line + Environment.NewLine);
                }
                catch
                {
                    // Ignore logging errors
                }
            }

            // Also write to debug output
            System.Diagnostics.Debug.WriteLine(line);
        }

        public static void Info(string message) => Log("INFO", message);
        public static void Debug(string message) => Log("DEBUG", message);
        public static void Warn(string message) => Log("WARN", message);
        public static void Error(string message) => Log("ERROR", message);
    }
}
