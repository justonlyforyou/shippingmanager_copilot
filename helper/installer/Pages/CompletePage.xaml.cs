using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;

namespace ShippingManagerCoPilot.Installer.Pages
{
    public partial class CompletePage : Page
    {
        private readonly MainWindow _mainWindow;
        private readonly string _installPath;

        public CompletePage(MainWindow mainWindow, string installPath)
        {
            InitializeComponent();
            _mainWindow = mainWindow;
            _installPath = installPath;

            InstallPathText.Text = installPath;
        }

        private void FinishButton_Click(object sender, RoutedEventArgs e)
        {
            // Launch app if checkbox is checked
            if (LaunchCheckbox.IsChecked == true)
            {
                try
                {
                    var exePath = Path.Combine(_installPath, "ShippingManagerCoPilot-Launcher.exe");
                    if (File.Exists(exePath))
                    {
                        var startInfo = new ProcessStartInfo
                        {
                            FileName = exePath,
                            WorkingDirectory = _installPath,
                            UseShellExecute = true
                        };
                        Process.Start(startInfo);
                    }
                }
                catch (System.Exception ex)
                {
                    MessageBox.Show($"Failed to launch app: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
                }
            }

            Application.Current.Shutdown();
        }
    }
}
