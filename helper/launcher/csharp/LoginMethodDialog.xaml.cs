using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using WpfColor = System.Windows.Media.Color;

namespace ShippingManagerCoPilot.Launcher
{
    public partial class LoginMethodDialog : Window
    {
        private static readonly SolidColorBrush SelectedBorder = new(WpfColor.FromRgb(0x3b, 0x82, 0xf6)); // #3b82f6
        private static readonly SolidColorBrush NormalBorder = new(WpfColor.FromRgb(0x40, 0x40, 0x40)); // #404040
        private static readonly SolidColorBrush NormalBg = new(WpfColor.FromRgb(0x25, 0x25, 0x25)); // #252525
        private static readonly SolidColorBrush SelectedBg = new(WpfColor.FromArgb(0x1A, 0x3b, 0x82, 0xf6)); // #3b82f6 10%

        public LoginMethod? SelectedMethod { get; private set; }

        public LoginMethodDialog()
        {
            InitializeComponent();
        }

        private void SteamCard_Click(object sender, MouseButtonEventArgs e)
        {
            SelectCard(LoginMethod.Steam);
        }

        private void BrowserCard_Click(object sender, MouseButtonEventArgs e)
        {
            SelectCard(LoginMethod.Browser);
        }

        private void SelectCard(LoginMethod method)
        {
            // Reset both cards
            SteamCard.BorderBrush = NormalBorder;
            SteamCard.Background = NormalBg;
            BrowserCard.BorderBrush = NormalBorder;
            BrowserCard.Background = NormalBg;

            // Select the clicked card
            if (method == LoginMethod.Steam)
            {
                SteamCard.BorderBrush = SelectedBorder;
                SteamCard.Background = SelectedBg;
            }
            else
            {
                BrowserCard.BorderBrush = SelectedBorder;
                BrowserCard.Background = SelectedBg;
            }

            SelectedMethod = method;
            ContinueButton.IsEnabled = true;
        }

        private void Continue_Click(object sender, RoutedEventArgs e)
        {
            if (SelectedMethod != null)
            {
                DialogResult = true;
                Close();
            }
        }

        private void Cancel_Click(object sender, RoutedEventArgs e)
        {
            DialogResult = false;
            Close();
        }
    }
}
