namespace ShippingManagerCoPilot.Launcher
{
    public class SessionInfo
    {
        public string UserId { get; set; } = "";
        public string CompanyName { get; set; } = "";
        public string Cookie { get; set; } = "";
        public string LoginMethod { get; set; } = "";
        public bool Autostart { get; set; } = true;
        public int Port { get; set; }
    }

    public enum LoginMethod
    {
        Steam,
        Browser
    }
}
