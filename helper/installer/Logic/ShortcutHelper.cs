using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace ShippingManagerCoPilot.Installer.Logic
{
    /// <summary>
    /// Helper class for creating Windows shortcuts using P/Invoke
    /// </summary>
    public static class ShortcutHelper
    {
        /// <summary>
        /// Creates a desktop shortcut
        /// </summary>
        /// <param name="targetPath">Path to the executable</param>
        /// <param name="shortcutName">Name of the shortcut (without .lnk extension)</param>
        /// <param name="description">Description of the shortcut</param>
        public static void CreateDesktopShortcut(string targetPath, string shortcutName, string description)
        {
            var desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
            var shortcutPath = Path.Combine(desktopPath, $"{shortcutName}.lnk");
            CreateShortcut(shortcutPath, targetPath, description);
        }

        /// <summary>
        /// Creates a start menu shortcut
        /// </summary>
        /// <param name="targetPath">Path to the executable</param>
        /// <param name="shortcutName">Name of the shortcut (without .lnk extension)</param>
        /// <param name="description">Description of the shortcut</param>
        public static void CreateStartMenuShortcut(string targetPath, string shortcutName, string description)
        {
            var startMenuPath = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            var appFolderPath = Path.Combine(startMenuPath, "ShippingManager CoPilot");

            // Create app folder in start menu
            Directory.CreateDirectory(appFolderPath);

            var shortcutPath = Path.Combine(appFolderPath, $"{shortcutName}.lnk");
            CreateShortcut(shortcutPath, targetPath, description);
        }

        /// <summary>
        /// Creates a Windows shortcut using Shell32
        /// </summary>
        private static void CreateShortcut(string shortcutPath, string targetPath, string description)
        {
            try
            {
                IShellLink link = (IShellLink)new ShellLink();

                link.SetPath(targetPath);
                // No arguments needed - C# launcher handles everything
                link.SetWorkingDirectory(Path.GetDirectoryName(targetPath));
                link.SetDescription(description);
                link.SetIconLocation(targetPath, 0);

                IPersistFile file = (IPersistFile)link;
                file.Save(shortcutPath, false);

                Marshal.ReleaseComObject(file);
                Marshal.ReleaseComObject(link);
            }
            catch (Exception ex)
            {
                throw new Exception($"Failed to create shortcut at {shortcutPath}: {ex.Message}", ex);
            }
        }

        /// <summary>
        /// Removes a desktop shortcut
        /// </summary>
        public static void RemoveDesktopShortcut(string shortcutName)
        {
            var desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
            var shortcutPath = Path.Combine(desktopPath, $"{shortcutName}.lnk");

            if (File.Exists(shortcutPath))
            {
                File.Delete(shortcutPath);
            }
        }

        /// <summary>
        /// Removes start menu shortcuts (including folder)
        /// </summary>
        public static void RemoveStartMenuShortcuts()
        {
            var startMenuPath = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            var appFolderPath = Path.Combine(startMenuPath, "ShippingManager CoPilot");

            if (Directory.Exists(appFolderPath))
            {
                Directory.Delete(appFolderPath, true);
            }
        }

        #region COM Interfaces and Classes for Shell Link

        [ComImport]
        [Guid("00021401-0000-0000-C000-000000000046")]
        private class ShellLink
        {
        }

        [ComImport]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        [Guid("000214F9-0000-0000-C000-000000000046")]
        private interface IShellLink
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, IntPtr pfd, int fFlags);
            void GetIDList(out IntPtr ppidl);
            void SetIDList(IntPtr pidl);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cchMaxName);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
            void GetHotkey(out short pwHotkey);
            void SetHotkey(short wHotkey);
            void GetShowCmd(out int piShowCmd);
            void SetShowCmd(int iShowCmd);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
            void Resolve(IntPtr hwnd, int fFlags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
        }

        [ComImport]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        [Guid("0000010b-0000-0000-C000-000000000046")]
        private interface IPersistFile
        {
            void GetClassID(out Guid pClassID);
            void IsDirty();
            void Load([In, MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
            void Save([In, MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [In, MarshalAs(UnmanagedType.Bool)] bool fRemember);
            void SaveCompleted([In, MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
            void GetCurFile([In, MarshalAs(UnmanagedType.LPWStr)] string ppszFileName);
        }

        #endregion
    }
}
