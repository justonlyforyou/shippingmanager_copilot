// Global using directives to resolve WPF vs WinForms conflicts
// We use WPF for most things, WinForms only for NotifyIcon (tray)

global using WpfMessageBox = System.Windows.MessageBox;
global using WpfMessageBoxButton = System.Windows.MessageBoxButton;
global using WpfMessageBoxImage = System.Windows.MessageBoxImage;
global using WpfMessageBoxResult = System.Windows.MessageBoxResult;
global using WpfButton = System.Windows.Controls.Button;
global using WpfWindow = System.Windows.Window;
global using WpfApplication = System.Windows.Application;

// WinForms for tray icon only
global using WinFormsNotifyIcon = System.Windows.Forms.NotifyIcon;
global using WinFormsContextMenuStrip = System.Windows.Forms.ContextMenuStrip;
global using WinFormsToolStripMenuItem = System.Windows.Forms.ToolStripMenuItem;
global using WinFormsToolTipIcon = System.Windows.Forms.ToolTipIcon;
