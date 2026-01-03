namespace ShippingManagerCoPilot.Launcher
{
    public class SessionInfo
    {
        public string UserId { get; set; } = "";
        public string CompanyName { get; set; } = "";
        public string? Cookie { get; set; } = "";
        public string LoginMethod { get; set; } = "";
        public bool Autostart { get; set; } = true;
        public string Host { get; set; } = "0.0.0.0";
        public int Port { get; set; }
        public bool Valid { get; set; } = true;
        public string? Error { get; set; }

        /// <summary>
        /// Gets the URL for this session. Uses localhost if host is 0.0.0.0 or 127.0.0.1
        /// </summary>
        public string Url => $"https://{(Host == "0.0.0.0" || Host == "127.0.0.1" ? "localhost" : Host)}:{Port}";
    }

    public enum LoginMethod
    {
        Steam,
        Browser
    }
}
