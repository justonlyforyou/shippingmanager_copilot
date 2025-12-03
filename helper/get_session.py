"""
Cross-platform session management for Shipping Manager CoPilot.
Browser-only login (no Steam support).

This module is used on macOS and Linux where Steam cookie extraction is not available.
For Windows with Steam support, use get_session_windows.py instead.
"""

import sqlite3
import os
import base64
import json
import urllib.parse
import sys
import subprocess
import time
import argparse
import requests
from pathlib import Path
import warnings
import urllib3
import hashlib
import platform

# Selenium imports for browser login
try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options as ChromeOptions
    from selenium.webdriver.chrome.service import Service as ChromeService
    from selenium.webdriver.firefox.options import Options as FirefoxOptions
    from selenium.webdriver.firefox.service import Service as FirefoxService
    from selenium.webdriver.safari.options import Options as SafariOptions
    SELENIUM_AVAILABLE = True
except ImportError:
    SELENIUM_AVAILABLE = False

# Try to import keyring for cross-platform secure storage
try:
    import keyring
    KEYRING_AVAILABLE = True
    print("[*] Using OS keyring for secure session storage", file=sys.stderr)
except ImportError:
    KEYRING_AVAILABLE = False
    print("[!] Warning: keyring module not available, using fallback encryption", file=sys.stderr)
    print("[!] Install with: pip install keyring", file=sys.stderr)

# Suppress all SSL warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
warnings.filterwarnings('ignore')

# --- Configuration ---
TARGET_DOMAIN = 'shippingmanager.cc'
TARGET_COOKIE_NAME = 'shipping_manager_session'

# Determine data directory based on execution mode and platform
if getattr(sys, 'frozen', False):
    # Running as compiled executable
    if platform.system() == 'Darwin':
        # macOS: ~/Library/Application Support/ShippingManagerCoPilot
        DATA_ROOT = Path(os.path.expanduser('~/Library/Application Support')) / 'ShippingManagerCoPilot' / 'userdata'
    elif platform.system() == 'Linux':
        # Linux: ~/.local/share/ShippingManagerCoPilot
        DATA_ROOT = Path(os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share'))) / 'ShippingManagerCoPilot' / 'userdata'
    else:
        # Fallback
        DATA_ROOT = Path(os.path.expanduser('~/.shippingmanager-copilot')) / 'userdata'
else:
    # Running as .py script - use userdata in project root
    SCRIPT_DIR_PARENT = Path(__file__).parent.parent
    DATA_ROOT = SCRIPT_DIR_PARENT / 'userdata'

DATA_ROOT.mkdir(parents=True, exist_ok=True)
SETTINGS_DIR = DATA_ROOT / 'settings'
SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
SESSIONS_FILE = SETTINGS_DIR / 'sessions.json'
SERVICE_NAME = 'ShippingManagerCoPilot'

# Determine helper directory for finding other helper scripts
if __name__ == '__main__':
    HELPER_DIR = Path(sys.executable).parent
else:
    HELPER_DIR = Path(__file__).parent

# SCRIPT_DIR is the project root (parent of helper/)
if getattr(sys, 'frozen', False):
    SCRIPT_DIR = Path(sys.executable).parent.parent if Path(sys.executable).parent.name == 'helper' else Path(sys.executable).parent
else:
    SCRIPT_DIR = Path(__file__).parent.parent


# =============================================================================
# ENCRYPTION HELPERS
# =============================================================================

def encrypt_cookie(cookie, user_id_or_account_name):
    """Encrypt cookie using OS keyring or fallback encryption."""
    if '_' in str(user_id_or_account_name):
        account_name = user_id_or_account_name
    else:
        account_name = f"session_{user_id_or_account_name}"

    if KEYRING_AVAILABLE:
        try:
            try:
                keyring.delete_password(SERVICE_NAME, account_name)
            except keyring.errors.PasswordDeleteError:
                pass

            cookie_str = str(cookie) if not isinstance(cookie, str) else cookie
            keyring.set_password(SERVICE_NAME, account_name, cookie_str)
            return f"KEYRING:{account_name}"
        except Exception as e:
            print(f"[!] Keyring storage failed for {account_name}, using fallback: {e}", file=sys.stderr)

    # Fallback: Basic obfuscation (not as secure as keyring!)
    try:
        machine_id = f"{platform.node()}{os.getlogin()}{platform.system()}"
        key = hashlib.sha256(machine_id.encode()).digest()
        encrypted = bytes([b ^ key[i % len(key)] for i, b in enumerate(cookie.encode())])
        return f"v1:{base64.b64encode(encrypted).decode()}"
    except Exception as e:
        print(f"[!] Fallback encryption failed: {e}", file=sys.stderr)
        return cookie


def decrypt_cookie(encrypted_data, user_id):
    """Decrypt cookie from encrypted storage."""
    if not encrypted_data:
        return None

    if encrypted_data.startswith('KEYRING:'):
        if KEYRING_AVAILABLE:
            try:
                account_name = encrypted_data[8:]
                password = keyring.get_password(SERVICE_NAME, account_name)
                return password
            except Exception as e:
                print(f"[!] Keyring retrieval failed: {e}", file=sys.stderr)
                return None
        else:
            print("[!] Data in keyring but keyring module not available", file=sys.stderr)
            return None

    if encrypted_data.startswith('v1:'):
        try:
            machine_id = f"{platform.node()}{os.getlogin()}{platform.system()}"
            key = hashlib.sha256(machine_id.encode()).digest()
            encrypted_bytes = base64.b64decode(encrypted_data[3:])
            decrypted = bytes([b ^ key[i % len(key)] for i, b in enumerate(encrypted_bytes)])
            return decrypted.decode()
        except Exception as e:
            print(f"[!] Fallback decryption failed: {e}", file=sys.stderr)
            return None

    print("[!] Warning: Detected plaintext cookie (not encrypted)", file=sys.stderr)
    return encrypted_data


def is_encrypted(data):
    """Check if data is encrypted."""
    if not data or not isinstance(data, str):
        return False
    return data.startswith('KEYRING:') or data.startswith('v1:')


# =============================================================================
# SESSION MANAGEMENT
# =============================================================================

def load_sessions():
    """Load saved sessions from sessions.json."""
    try:
        if SESSIONS_FILE.exists():
            with open(SESSIONS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {}
    except Exception as e:
        print(f"[!] Error loading sessions: {e}", file=sys.stderr)
        return {}


def save_session(user_id, cookie, company_name, login_method, app_platform=None, app_version=None):
    """Save session to sessions.json with encrypted cookies."""
    try:
        sessions = load_sessions()

        if isinstance(cookie, dict):
            shipping_cookie = cookie.get('shipping_manager_session')
            app_platform = cookie.get('app_platform', app_platform)
            app_version = cookie.get('app_version', app_version)
        else:
            shipping_cookie = cookie

        encrypted_cookie = encrypt_cookie(shipping_cookie, user_id)

        session_data = {
            'cookie': encrypted_cookie,
            'timestamp': int(time.time()),
            'company_name': company_name,
            'login_method': login_method
        }

        if app_platform:
            encrypted_platform = encrypt_cookie(app_platform, f'app_platform_{user_id}')
            session_data['app_platform'] = encrypted_platform

        if app_version:
            encrypted_version = encrypt_cookie(app_version, f'app_version_{user_id}')
            session_data['app_version'] = encrypted_version

        sessions[str(user_id)] = session_data

        SESSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)

        with open(SESSIONS_FILE, 'w', encoding='utf-8') as f:
            json.dump(sessions, f, indent=2)
            f.flush()
            os.fsync(f.fileno())

        time.sleep(0.5)

        encryption_type = "OS keyring" if encrypted_cookie.startswith('KEYRING:') else "fallback encryption"
        print(f"[+] Session saved for user {company_name} (ID: {user_id}, Method: {login_method}, Encryption: {encryption_type})", file=sys.stderr)
    except Exception as e:
        print(f"[!] Error saving session: {e}", file=sys.stderr)


def validate_session_cookie(cookie, user_id=None):
    """Validate session cookie with API. Returns user data if valid, None otherwise."""
    if isinstance(cookie, dict):
        session_cookie = cookie.get('shipping_manager_session')
        app_platform = cookie.get('app_platform')
        app_version = cookie.get('app_version')
    else:
        if is_encrypted(cookie):
            if not user_id:
                print("[!] Cannot decrypt cookie without user_id", file=sys.stderr)
                return None
            cookie = decrypt_cookie(cookie, user_id)
            if not cookie:
                return None
        session_cookie = cookie
        app_platform = None
        app_version = None

    try:
        cookie_header = f'{TARGET_COOKIE_NAME}={session_cookie}'
        if app_platform:
            cookie_header += f'; app_platform={app_platform}'
        if app_version:
            cookie_header += f'; app_version={app_version}'

        response = requests.post(
            f"https://{TARGET_DOMAIN}/api/user/get-user-settings",
            headers={
                'Cookie': cookie_header,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            },
            timeout=10,
            verify=False
        )

        if response.status_code == 200:
            data = response.json()
            if data.get('user', {}).get('id'):
                return data['user']
        return None
    except Exception as e:
        print(f"[!] Session validation error: {e}", file=sys.stderr)
        return None


def validate_all_sessions():
    """Validate all saved sessions. Returns list of valid sessions with their data."""
    sessions = load_sessions()

    if not sessions:
        print("[*] No saved sessions found", file=sys.stderr)
        return []

    print(f"[*] Found {len(sessions)} saved session(s)", file=sys.stderr)
    print(f"[*] Validating all sessions...", file=sys.stderr)

    valid_sessions = []

    sorted_sessions = sorted(
        sessions.items(),
        key=lambda x: x[1].get('timestamp', 0),
        reverse=True
    )

    for user_id, session_data in sorted_sessions:
        encrypted_cookie = session_data.get('cookie')
        company_name = session_data.get('company_name', 'Unknown')
        login_method = session_data.get('login_method', 'unknown')

        print(f"[*] Validating {company_name} (ID: {user_id})...", file=sys.stderr)

        if is_encrypted(encrypted_cookie):
            plaintext_cookie = decrypt_cookie(encrypted_cookie, user_id)
            if not plaintext_cookie:
                print(f"  Skipped (Credential missing - cannot decrypt)", file=sys.stderr)
                continue
        else:
            plaintext_cookie = encrypted_cookie

        user_data = validate_session_cookie(plaintext_cookie, user_id)
        if user_data:
            print(f"  Valid", file=sys.stderr)
            valid_sessions.append({
                'user_id': user_id,
                'cookie': plaintext_cookie,
                'company_name': user_data.get('company_name', company_name),
                'user_data': user_data,
                'login_method': login_method
            })
        else:
            print(f"  Expired (Method: {login_method})", file=sys.stderr)

    print(f"[*] {len(valid_sessions)} valid session(s) found", file=sys.stderr)
    return valid_sessions


def get_expired_sessions_with_methods():
    """Get all expired sessions."""
    sessions = load_sessions()

    if not sessions:
        return []

    expired_with_methods = []

    for user_id, session_data in sessions.items():
        encrypted_cookie = session_data.get('cookie')
        company_name = session_data.get('company_name', 'Unknown')
        login_method = session_data.get('login_method', 'unknown')

        user_data = validate_session_cookie(encrypted_cookie, user_id)
        if not user_data:
            expired_with_methods.append({
                'user_id': user_id,
                'company_name': company_name,
                'login_method': 'browser'  # On non-Windows, always browser
            })

    return expired_with_methods


def get_user_from_cookie(cookie):
    """Get user data from a validated cookie."""
    return validate_session_cookie(cookie)


# =============================================================================
# DIALOG HELPERS
# =============================================================================

def get_executable_extension():
    """Get the executable extension for the current platform."""
    if platform.system() == 'Windows':
        return '.exe'
    return ''


def show_session_selector(valid_sessions, expired_sessions=None, show_action_buttons=True):
    """Show session selector dialog. Returns selected session or None."""
    try:
        ext = get_executable_extension()

        session_list = [
            {
                'user_id': str(s['user_id']),
                'company_name': s['company_name'],
                'login_method': s.get('login_method', 'browser')
            }
            for s in valid_sessions
        ]

        expired_list = []
        if expired_sessions:
            expired_list = [
                {
                    'user_id': str(s['user_id']),
                    'company_name': s['company_name'],
                    'login_method': 'browser'  # Always browser on non-Windows
                }
                for s in expired_sessions
            ]

        session_json = json.dumps(session_list)
        expired_json = json.dumps(expired_list)
        show_buttons_str = str(show_action_buttons)

        if getattr(sys, 'frozen', False):
            selector_exe = HELPER_DIR / f'session-selector{ext}'
            proc = subprocess.Popen(
                [str(selector_exe), session_json, expired_json, show_buttons_str],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
        else:
            selector_exe = SCRIPT_DIR / 'dist' / f'session-selector{ext}'
            if selector_exe.exists():
                proc = subprocess.Popen(
                    [str(selector_exe), session_json, expired_json, show_buttons_str],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True
                )
            else:
                selector_script = SCRIPT_DIR / 'helper' / 'session_selector.py'
                proc = subprocess.Popen(
                    [sys.executable, str(selector_script), session_json, expired_json, show_buttons_str],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True
                )

        try:
            stdout, stderr = proc.communicate(timeout=300)
            result_code = proc.returncode
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            result_code = -1

        print(f"[get_session] Subprocess result_code: {result_code}", file=sys.stderr)
        print(f"[get_session] Subprocess stdout: {repr(stdout)}", file=sys.stderr)
        print(f"[get_session] Subprocess stderr: {repr(stderr)}", file=sys.stderr)

        if result_code == 0 and stdout.strip():
            parsed_result = json.loads(stdout.strip())
            print(f"[get_session] Parsed JSON result: {parsed_result}", file=sys.stderr)
            return parsed_result
        else:
            print("[-] User cancelled session selection or subprocess failed", file=sys.stderr)
            return None

    except Exception as e:
        print(f"[-] Error showing session selector: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return None


def show_login_dialog():
    """Show login dialog and return user selection."""
    try:
        ext = get_executable_extension()

        if getattr(sys, 'frozen', False):
            dialog_exe = HELPER_DIR / f'login-dialog{ext}'
            result = subprocess.run(
                [str(dialog_exe)],
                capture_output=True,
                text=True,
                timeout=300
            )
        else:
            dialog_exe = SCRIPT_DIR / 'dist' / f'login-dialog{ext}'
            if dialog_exe.exists():
                result = subprocess.run(
                    [str(dialog_exe)],
                    capture_output=True,
                    text=True,
                    timeout=300
                )
            else:
                dialog_script = SCRIPT_DIR / 'helper' / 'login_dialog.py'
                result = subprocess.run(
                    [sys.executable, str(dialog_script)],
                    capture_output=True,
                    text=True,
                    timeout=300
                )

        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
        else:
            print("[-] User cancelled login dialog", file=sys.stderr)
            return None
    except Exception as e:
        print(f"[-] Error showing login dialog: {e}", file=sys.stderr)
        return None


def show_expired_sessions_dialog(expired_sessions):
    """Show expired sessions renewal dialog."""
    try:
        ext = get_executable_extension()
        sessions_json = json.dumps(expired_sessions)

        if getattr(sys, 'frozen', False):
            dialog_exe = HELPER_DIR / f'expired-sessions-dialog{ext}'
            result = subprocess.run(
                [str(dialog_exe), sessions_json],
                capture_output=True,
                text=True,
                timeout=300
            )
        else:
            dialog_exe = SCRIPT_DIR / 'dist' / f'expired-sessions-dialog{ext}'
            if dialog_exe.exists():
                result = subprocess.run(
                    [str(dialog_exe), sessions_json],
                    capture_output=True,
                    text=True,
                    timeout=300
                )
            else:
                dialog_script = SCRIPT_DIR / 'helper' / 'expired_sessions_dialog.py'
                result = subprocess.run(
                    [sys.executable, str(dialog_script), sessions_json],
                    capture_output=True,
                    text=True,
                    timeout=300
                )

        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
        else:
            print("[-] User cancelled expired sessions dialog", file=sys.stderr)
            return None
    except Exception as e:
        print(f"[-] Error showing expired sessions dialog: {e}", file=sys.stderr)
        return None


# =============================================================================
# BROWSER LOGIN METHOD (SELENIUM)
# =============================================================================

def detect_browser():
    """Detect available compatible browser and return appropriate driver."""
    system = platform.system()

    print("[*] Detecting available browsers...", file=sys.stderr)

    if not SELENIUM_AVAILABLE:
        print("[-] ERROR: Selenium not installed. Please run: pip install selenium", file=sys.stderr)
        sys.exit(1)

    # Determine webdriver directory
    if getattr(sys, 'frozen', False):
        webdriver_dir = os.path.join(HELPER_DIR, 'webdrivers')
    else:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        webdriver_dir = os.path.join(script_dir, 'webdrivers')

    # WebDriver paths (platform-specific)
    if system == 'Darwin':
        chromedriver_path = os.path.join(webdriver_dir, 'chromedriver')
        geckodriver_path = os.path.join(webdriver_dir, 'geckodriver')
    elif system == 'Linux':
        chromedriver_path = os.path.join(webdriver_dir, 'chromedriver')
        geckodriver_path = os.path.join(webdriver_dir, 'geckodriver')
    else:
        chromedriver_path = os.path.join(webdriver_dir, 'chromedriver.exe')
        geckodriver_path = os.path.join(webdriver_dir, 'geckodriver.exe')

    # Browser priority - Safari first on macOS since it's built-in
    if system == 'Darwin':
        browsers_to_try = ['safari', 'chrome', 'firefox']
    else:
        browsers_to_try = ['chrome', 'firefox']

    for browser_name in browsers_to_try:
        try:
            if browser_name == 'safari' and system == 'Darwin':
                print(f"[*] Trying Safari...", file=sys.stderr)
                options = SafariOptions()
                driver = webdriver.Safari(options=options)
                print(f"[+] Using Safari browser", file=sys.stderr)
                return driver

            elif browser_name == 'chrome':
                print(f"[*] Trying Chrome...", file=sys.stderr)
                options = ChromeOptions()
                options.add_argument("--start-maximized")
                options.add_argument("--disable-blink-features=AutomationControlled")
                options.add_experimental_option("excludeSwitches", ["enable-automation"])
                options.add_experimental_option('useAutomationExtension', False)

                if os.path.exists(chromedriver_path):
                    service = ChromeService(executable_path=chromedriver_path)
                    driver = webdriver.Chrome(service=service, options=options)
                else:
                    driver = webdriver.Chrome(options=options)

                print(f"[+] Using Chrome browser", file=sys.stderr)
                return driver

            elif browser_name == 'firefox':
                print(f"[*] Trying Firefox...", file=sys.stderr)
                options = FirefoxOptions()
                options.set_preference("dom.webdriver.enabled", False)

                if os.path.exists(geckodriver_path):
                    service = FirefoxService(executable_path=geckodriver_path)
                    driver = webdriver.Firefox(service=service, options=options)
                else:
                    driver = webdriver.Firefox(options=options)

                print(f"[+] Using Firefox browser", file=sys.stderr)
                return driver

        except Exception as e:
            print(f"[*] {browser_name.capitalize()} not available: {str(e)[:50]}...", file=sys.stderr)
            continue

    print("[-] ERROR: No compatible browser found!", file=sys.stderr)
    print("[-] Please install one of the following browsers:", file=sys.stderr)
    print("[-]   - Google Chrome", file=sys.stderr)
    print("[-]   - Mozilla Firefox", file=sys.stderr)
    if system == 'Darwin':
        print("[-]   - Safari (built-in, enable in Develop menu)", file=sys.stderr)
    sys.exit(1)


def browser_login():
    """Browser-based login using Selenium. Returns cookie or None."""
    print("[*] Using Selenium browser automation...", file=sys.stderr)
    print(f"[*] Starting browser login for '{TARGET_DOMAIN}'...", file=sys.stderr)

    driver = None
    try:
        driver = detect_browser()

        print(f"[*] Navigating to https://{TARGET_DOMAIN}...", file=sys.stderr)
        driver.get(f"https://{TARGET_DOMAIN}")

        print("[*] Waiting for successful login...", file=sys.stderr)
        print("[*] Please log in to Shipping Manager in the browser window.", file=sys.stderr)

        cookie = None
        max_wait = 300
        start_time = time.time()
        last_status = None

        while time.time() - start_time < max_wait:
            try:
                try:
                    driver.current_url
                except Exception:
                    print("", file=sys.stderr)
                    print("[-] Browser was closed by user", file=sys.stderr)
                    return None

                cookies = driver.get_cookies()
                temp_cookie = None

                for c in cookies:
                    if c['name'] == TARGET_COOKIE_NAME:
                        raw_cookie = c['value']
                        temp_cookie = urllib.parse.unquote(raw_cookie).strip()
                        break

                if temp_cookie:
                    try:
                        test_response = requests.post(
                            f"https://{TARGET_DOMAIN}/api/user/get-user-settings",
                            headers={
                                'Cookie': f'{TARGET_COOKIE_NAME}={temp_cookie}',
                                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                            },
                            timeout=10,
                            verify=False
                        )

                        if test_response.status_code == 200:
                            data = test_response.json()
                            if data.get('user', {}).get('id'):
                                print("[+] Login successful! Session validated.", file=sys.stderr)
                                print(f"[+] User: {data['user'].get('company_name', 'Unknown')} (ID: {data['user']['id']})", file=sys.stderr)
                                cookie = temp_cookie
                                break
                            else:
                                if last_status != "no_user_data":
                                    print("[*] Cookie found but no user data yet...", file=sys.stderr)
                                    last_status = "no_user_data"
                        else:
                            if last_status != test_response.status_code:
                                print(f"[*] Waiting for login... (API status: {test_response.status_code})", file=sys.stderr)
                                last_status = test_response.status_code
                    except Exception as e:
                        if last_status != "api_error":
                            print(f"[*] Waiting for login to complete...", file=sys.stderr)
                            last_status = "api_error"
                else:
                    if last_status != "no_cookie":
                        print("[*] Waiting for session cookie...", file=sys.stderr)
                        last_status = "no_cookie"

                time.sleep(2)

            except Exception as e:
                print(f"[!] Error: {e}", file=sys.stderr)
                time.sleep(2)

        if not cookie:
            print("[-] ERROR: Login not completed after 5 minutes.", file=sys.stderr)
            if driver:
                driver.quit()
            return None

        print("[+] Session cookie successfully validated!", file=sys.stderr)

        # Show success message in browser
        try:
            driver.execute_script("""
                const overlay = document.createElement('div');
                overlay.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.9);
                    z-index: 999999;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                `;

                const message = document.createElement('div');
                message.style.cssText = `
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    padding: 40px 60px;
                    border-radius: 20px;
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
                    text-align: center;
                    color: white;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                `;

                message.innerHTML = `
                    <div style="font-size: 72px; margin-bottom: 20px;">&#10004;</div>
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 10px;">Login successful!</div>
                    <div style="font-size: 18px; opacity: 0.9;">You can close the browser now</div>
                `;

                overlay.appendChild(message);
                document.body.appendChild(overlay);
            """)
        except Exception as e:
            print(f"[!] Could not display message in browser: {e}", file=sys.stderr)

        time.sleep(3)

        # Extract ALL cookies for this account (session, app_platform, app_version)
        print("[*] Extracting all cookies for this account...", file=sys.stderr)
        all_cookies = {}
        try:
            final_cookies = driver.get_cookies()
            for c in final_cookies:
                cookie_name = c['name']
                raw_value = c['value']
                # Decode URL encoding (e.g., %3D -> =)
                cookie_value = urllib.parse.unquote(raw_value).strip()

                if cookie_name == TARGET_COOKIE_NAME:
                    all_cookies['shipping_manager_session'] = cookie_value
                    print(f"[+] Session cookie: {len(cookie_value)} chars (was {len(raw_value)} raw)", file=sys.stderr)
                elif cookie_name == 'app_platform':
                    all_cookies['app_platform'] = cookie_value
                    print(f"[+] Found app_platform cookie: {len(cookie_value)} chars", file=sys.stderr)
                elif cookie_name == 'app_version':
                    all_cookies['app_version'] = cookie_value
                    print(f"[+] Found app_version cookie: {len(cookie_value)} chars", file=sys.stderr)

        except Exception as e:
            print(f"[!] Could not extract all cookies: {e}", file=sys.stderr)
            print("[!] Using session cookie only", file=sys.stderr)
            all_cookies['shipping_manager_session'] = cookie

        # Ensure we have at least the session cookie
        if 'shipping_manager_session' not in all_cookies:
            all_cookies['shipping_manager_session'] = cookie

        print(f"[+] Browser login successful! Extracted {len(all_cookies)} cookie(s)", file=sys.stderr)
        return all_cookies

    except Exception as e:
        print(f"[-] CRITICAL ERROR during browser login: {e}", file=sys.stderr)
        if driver:
            try:
                driver.quit()
            except:
                pass
        return None


# =============================================================================
# MAIN
# =============================================================================

def main(save_only=False):
    """Main entry point with session management and smart login flow."""
    # STEP 1: Validate all saved sessions
    print("[1/3] Checking for saved sessions...", file=sys.stderr)
    valid_sessions = validate_all_sessions()

    user_chose_add_new = False
    expired_sessions = get_expired_sessions_with_methods()

    # Main loop
    while len(valid_sessions) > 0 or len(expired_sessions) > 0:
        print("", file=sys.stderr)

        selector_result = show_session_selector(valid_sessions, expired_sessions)

        if not selector_result:
            print("[-] Session selection cancelled", file=sys.stderr)
            if __name__ == "__main__":
                sys.exit(0)
            else:
                return None

        action = selector_result.get('action')

        if action == 'new_session':
            print("[*] User chose to add new session", file=sys.stderr)
            user_chose_add_new = True
            break

        if action == 'refresh_sessions':
            print("[*] Select session to refresh...", file=sys.stderr)

            all_sessions_for_refresh = valid_sessions + expired_sessions

            if not all_sessions_for_refresh:
                print("[!] No sessions available to refresh", file=sys.stderr)
                continue

            refresh_selector_result = show_session_selector(all_sessions_for_refresh, [], show_action_buttons=False)

            if not refresh_selector_result:
                continue

            refresh_action = refresh_selector_result.get('action')

            if refresh_action == 'use_session':
                selected_user_id = refresh_selector_result.get('user_id')

                session_to_refresh = None
                for s in all_sessions_for_refresh:
                    if s['user_id'] == selected_user_id:
                        session_to_refresh = s
                        break

                if session_to_refresh:
                    print("", file=sys.stderr)
                    print(f"Refreshing: {session_to_refresh['company_name']}", file=sys.stderr)

                    # Always use browser login on non-Windows
                    renewal_cookie = browser_login()

                    if renewal_cookie:
                        renewal_user_data = get_user_from_cookie(renewal_cookie)
                        if renewal_user_data and str(renewal_user_data.get('id')) == str(selected_user_id):
                            save_session(
                                str(renewal_user_data['id']),
                                renewal_cookie,
                                renewal_user_data.get('company_name', 'Unknown'),
                                'browser'
                            )
                            print(f"[+] Session refreshed for {renewal_user_data.get('company_name')}", file=sys.stderr)
                        else:
                            print(f"[-] Refresh failed - wrong account", file=sys.stderr)
                    else:
                        print(f"[-] Failed to get cookie", file=sys.stderr)

                    valid_sessions = validate_all_sessions()
                    expired_sessions = get_expired_sessions_with_methods()
                    continue

            continue

        if action == 'use_session':
            selected_user_id = selector_result.get('user_id')
            print(f"[+] Using session for user ID: {selected_user_id}", file=sys.stderr)

            cookie = None
            user_data = None
            for session in valid_sessions:
                if str(session['user_id']) == str(selected_user_id):
                    cookie = session['cookie']
                    user_data = session['user_data']
                    break

            if not cookie or not user_data:
                print(f"[-] ERROR: Session data not found for user {selected_user_id}", file=sys.stderr)
                sys.exit(1)

            print("", file=sys.stderr)
            print(f"Logged in as: {user_data.get('company_name', 'Unknown')}", file=sys.stderr)

            if __name__ == "__main__":
                print(selected_user_id)
                sys.exit(0)
            else:
                return selected_user_id

        elif selector_result.get('action') == 'new_session':
            print("[+] Adding new session...", file=sys.stderr)
            break
        else:
            print("[-] Invalid selector result", file=sys.stderr)
            sys.exit(1)

    # STEP 2: Browser login (only option on non-Windows)
    print("", file=sys.stderr)
    print("[2/3] Starting browser login...", file=sys.stderr)

    cookie = browser_login()

    if not cookie:
        print("", file=sys.stderr)
        print("[-] Login failed - no cookie obtained", file=sys.stderr)
        if __name__ == "__main__":
            sys.exit(1)
        else:
            return None

    # STEP 3: Get user data from cookie
    print("", file=sys.stderr)
    print("[3/3] Validating session and retrieving user data...", file=sys.stderr)
    user_data = get_user_from_cookie(cookie)

    if not user_data:
        print("[-] ERROR: Failed to validate session cookie", file=sys.stderr)
        if __name__ == "__main__":
            sys.exit(1)
        else:
            return None

    user_id = user_data.get('id')
    company_name = user_data.get('company_name', 'Unknown')

    print(f"[+] Logged in as: {company_name} (ID: {user_id})", file=sys.stderr)

    # Save session
    print(f"[*] Saving session for future use...", file=sys.stderr)
    save_session(user_id, cookie, company_name, 'browser')

    print("", file=sys.stderr)
    print("  Login Complete", file=sys.stderr)

    if __name__ == "__main__":
        print(user_id)
        sys.exit(0)
    else:
        return user_id


def get_user_session():
    """API function for importing this module directly."""
    try:
        return main(save_only=True)
    except SystemExit:
        return None
    except KeyboardInterrupt:
        return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Shipping Manager Session Manager - Cross-platform (Browser only)')
    parser.add_argument(
        '--save-only',
        action='store_true',
        help='(Deprecated - now always on) Save session to encrypted storage'
    )

    args = parser.parse_args()

    try:
        main(save_only=True)
    except KeyboardInterrupt:
        sys.exit(0)
