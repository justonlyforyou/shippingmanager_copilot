#!/usr/bin/env python3
"""
Certificate Manager for Shipping Manager CoPilot

Handles installation, uninstallation, and download of CA certificates
for Windows, macOS, and Linux.
"""

import os
import sys
import subprocess
import platform
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox
from datetime import datetime

# Dark theme colors (matching main app)
BG_COLOR = "#111827"
FG_COLOR = "#e0e0e0"
ACCENT_COLOR = "#3b82f6"
CARD_BG = "#1f2937"
WARNING_COLOR = "#f59e0b"
ERROR_COLOR = "#ef4444"

# Determine if running as compiled .exe or as script
IS_FROZEN = getattr(sys, 'frozen', False)
if IS_FROZEN:
    PROJECT_ROOT = Path(sys.executable).parent
    # For AppData (already contains ShippingManagerCoPilot/userdata)
    DATA_ROOT = Path(os.environ['LOCALAPPDATA']) / 'ShippingManagerCoPilot' / 'userdata'
else:
    PROJECT_ROOT = Path(__file__).parent.parent
    DATA_ROOT = PROJECT_ROOT / 'userdata'

# Certificate paths
CERTS_DIR = DATA_ROOT / 'certs'
CA_CERT_PATH = CERTS_DIR / 'ca-cert.pem'
LOG_FILE = DATA_ROOT / 'logs' / 'cert-manager.log'

def log(message):
    """Write to certificate manager log file"""
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(f"[{timestamp}] {message}\n")
        print(f"[Certificate Manager] {message}", file=sys.stderr)
    except Exception as e:
        print(f"[Certificate Manager] Log error: {e}", file=sys.stderr)

def show_custom_dialog(title, message, dialog_type='info', buttons=['OK']):
    """
    Show custom styled dialog matching app design

    Args:
        title: Dialog title
        message: Dialog message
        dialog_type: 'info', 'warning', 'error', 'question'
        buttons: List of button labels (e.g., ['Yes', 'No'])

    Returns:
        str: Label of clicked button, or None if closed
    """
    root = tk.Tk()
    root.withdraw()
    root.title(title)
    root.resizable(False, False)
    root.configure(bg=BG_COLOR)

    # Icon mapping
    icons = {
        'info': 'ℹ️',
        'warning': '⚠️',
        'error': '❌',
        'question': '❓'
    }
    icon = icons.get(dialog_type, 'ℹ️')

    # Header
    header_frame = tk.Frame(root, bg=BG_COLOR)
    header_frame.pack(pady=(20, 10), padx=30, fill=tk.X)

    title_label = tk.Label(
        header_frame,
        text=f"{icon} {title}",
        font=("Segoe UI", 16, "bold"),
        bg=BG_COLOR,
        fg=ACCENT_COLOR
    )
    title_label.pack()

    # Message
    message_frame = tk.Frame(root, bg=BG_COLOR)
    message_frame.pack(pady=20, padx=40, fill=tk.BOTH, expand=True)

    message_label = tk.Label(
        message_frame,
        text=message,
        font=("Segoe UI", 10),
        bg=BG_COLOR,
        fg=FG_COLOR,
        justify=tk.LEFT,
        wraplength=450
    )
    message_label.pack()

    # Store result
    result = {'clicked': None}

    def on_button_click(label):
        result['clicked'] = label
        root.quit()
        root.destroy()

    def on_close():
        result['clicked'] = None
        root.quit()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)

    # Buttons
    button_frame = tk.Frame(root, bg=BG_COLOR)
    button_frame.pack(pady=20)

    for i, label in enumerate(buttons):
        # First button is accent color, others are gray
        if i == 0 and dialog_type == 'question':
            bg = ACCENT_COLOR
            active_bg = "#2563eb"
        elif label in ['Yes', 'OK']:
            bg = ACCENT_COLOR
            active_bg = "#2563eb"
        else:
            bg = "#4b5563"
            active_bg = "#6b7280"

        btn = tk.Button(
            button_frame,
            text=label,
            command=lambda l=label: on_button_click(l),
            font=("Segoe UI", 11, "bold" if i == 0 else "normal"),
            bg=bg,
            fg="white",
            activebackground=active_bg,
            activeforeground="white",
            relief=tk.RAISED,
            borderwidth=2,
            cursor="hand2",
            width=12,
            pady=8
        )
        btn.pack(side=tk.LEFT, padx=8)

    # Position window centered
    root.update_idletasks()
    width = 550
    height = root.winfo_reqheight() + 40
    screen_width = root.winfo_screenwidth()
    screen_height = root.winfo_screenheight()
    x = (screen_width - width) // 2
    y = (screen_height - height) // 2

    root.geometry(f"{width}x{height}+{x}+{y}")
    root.deiconify()
    root.attributes('-topmost', True)
    root.lift()
    root.focus_force()

    root.mainloop()
    return result['clicked']

def is_certificate_installed(common_name='Shipping Manager CoPilot CA'):
    """
    Check if a certificate with the given Common Name is installed in the system trust store.

    Args:
        common_name: Certificate CN to search for

    Returns:
        bool: True if certificate is installed, False otherwise
    """
    system = platform.system()

    try:
        if system == 'Windows':
            # Use certutil to check if certificate exists in Root store
            result = subprocess.run(
                ['certutil', '-verifystore', 'Root', common_name],
                capture_output=True,
                text=True,
                timeout=10
            )
            return result.returncode == 0

        elif system == 'Darwin':  # macOS
            # Check if certificate exists in System keychain
            result = subprocess.run(
                ['security', 'find-certificate', '-c', common_name, '/Library/Keychains/System.keychain'],
                capture_output=True,
                text=True,
                timeout=10
            )
            return result.returncode == 0

        elif system == 'Linux':
            # Check if certificate exists in ca-certificates directory
            cert_file = Path(f'/usr/local/share/ca-certificates/shipping-manager-copilot-ca.crt')
            return cert_file.exists()

        else:
            return False

    except Exception as e:
        print(f"[Certificate Manager] Error checking certificate: {e}", file=sys.stderr)
        return False

def get_all_installed_certificates():
    """
    Get list of all Shipping Manager CoPilot certificates installed in system trust store.

    Returns:
        list: List of certificate subject names found
    """
    system = platform.system()
    certs_found = []

    try:
        if system == 'Windows':
            # List all certificates in Root store and filter for our CA
            result = subprocess.run(
                ['certutil', '-store', 'Root'],
                capture_output=True,
                text=True,
                timeout=30
            )

            if result.returncode == 0:
                lines = result.stdout.split('\n')
                for i, line in enumerate(lines):
                    # Search for exact CN string (language-independent)
                    if 'CN=Shipping Manager CoPilot CA' in line or 'CN=Shipping Manager Chat CA' in line:
                        # Extract the full DN (after the colon)
                        if ':' in line:
                            subject = line.split(':', 1)[1].strip()
                            # Avoid duplicates
                            if subject not in certs_found:
                                certs_found.append(subject)

        elif system == 'Darwin':
            # Find all certificates with our organization name
            result = subprocess.run(
                ['security', 'find-certificate', '-a', '-c', 'Shipping Manager CoPilot', '/Library/Keychains/System.keychain'],
                capture_output=True,
                text=True,
                timeout=30
            )

            if result.returncode == 0:
                # Parse output for certificate names
                lines = result.stdout.split('\n')
                for line in lines:
                    if '"labl"<blob>=' in line:
                        # Extract label (certificate name)
                        label = line.split('"labl"<blob>=')[1].strip().strip('"')
                        if 'Shipping Manager CoPilot' in label:
                            certs_found.append(label)

        elif system == 'Linux':
            # List all certificates in ca-certificates directory
            cert_dir = Path('/usr/local/share/ca-certificates')
            if cert_dir.exists():
                for cert_file in cert_dir.glob('*shipping*manager*copilot*.crt'):
                    certs_found.append(cert_file.stem)

    except Exception as e:
        print(f"[Certificate Manager] Error listing certificates: {e}", file=sys.stderr)

    return certs_found

def install_certificate():
    """
    Install the CA certificate to the system trust store.

    Returns:
        bool: True if successful, False otherwise
    """
    log('install_certificate() called')
    log(f'Certificate path: {CA_CERT_PATH}')

    if not CA_CERT_PATH.exists():
        log('ERROR: Certificate file not found')
        show_custom_dialog(
            "Certificate Not Found",
            f"CA certificate not found at:\n{CA_CERT_PATH}\n\n"
            "Please start the application first to generate certificates.",
            dialog_type='error',
            buttons=['OK']
        )
        return False

    # Check if ANY of our certificates are already installed (old or new)
    all_certs = get_all_installed_certificates()
    log(f'Found {len(all_certs)} existing certificate(s): {all_certs}')

    if all_certs:
        response = show_custom_dialog(
            "Old Certificates Found",
            f"Found {len(all_certs)} old Shipping Manager certificate(s) in the system trust store.\n\n"
            "These will be removed and replaced with the new certificate.\n\n"
            "Continue?",
            dialog_type='question',
            buttons=['Yes', 'No']
        )

        log(f'Replace old certificates response: {response}')
        if response != 'Yes':
            log('User cancelled installation')
            return False

        # Uninstall ALL old certificates first
        log('Uninstalling ALL old certificates first')
        uninstall_certificates(silent=True)

    system = platform.system()

    try:
        if system == 'Windows':
            log('Windows: Showing UAC info dialog')

            show_custom_dialog(
                "Admin Rights Required",
                "Installing the certificate requires administrator privileges.\n\n"
                "A User Account Control (UAC) dialog will appear.\n"
                "Please click 'Yes' to allow the installation.",
                dialog_type='info',
                buttons=['OK']
            )

            # Validate path (defense in depth)
            cert_path_str = str(CA_CERT_PATH)
            if "'" in cert_path_str or '"' in cert_path_str or ';' in cert_path_str:
                raise ValueError('Invalid certificate path detected')

            # Use Windows Shell API to trigger UAC
            import ctypes
            import time

            log(f"Installing certificate from: {cert_path_str}")

            # Use CMD batch file approach (more reliable for waiting)
            import tempfile

            # Create batch file with installation command
            # Use full path to certutil to avoid path issues
            batch_content = f'@echo off\nC:\\Windows\\System32\\certutil.exe -addstore -f Root "{cert_path_str}" > "{cert_path_str}.install.log" 2>&1\nexit\n'

            with tempfile.NamedTemporaryFile(mode='w', suffix='.bat', delete=False) as bat_file:
                bat_file.write(batch_content)
                bat_path = bat_file.name

            log(f"Created batch file: {bat_path}")
            log(f"Calling ShellExecuteW with runas verb")

            # ShellExecute with runas verb
            ret = ctypes.windll.shell32.ShellExecuteW(
                None,                                      # hwnd
                "runas",                                   # operation (triggers UAC)
                bat_path,                                  # file
                "",                                        # parameters
                None,                                      # directory
                1                                          # SW_SHOWNORMAL
            )

            log(f"ShellExecuteW returned: {ret}")

            # ShellExecute returns >32 on success, <=32 on error
            if ret <= 32:
                # Clean up batch file
                try:
                    os.unlink(bat_path)
                except:
                    pass

                error_codes = {
                    0: "Out of memory or resources",
                    2: "File not found",
                    3: "Path not found",
                    5: "Access denied",
                    8: "Out of memory",
                    26: "Sharing violation",
                    27: "File association not complete",
                    28: "DDE timeout",
                    29: "DDE transaction failed",
                    30: "DDE busy",
                    31: "No file association",
                    32: "DLL not found"
                }
                error_msg = error_codes.get(ret, f"Unknown error code {ret}")
                raise Exception(f"ShellExecute failed: {error_msg}")

            # Wait for batch to complete
            log("Waiting 5 seconds for installation to complete...")
            time.sleep(5)

            # Clean up batch file
            try:
                os.unlink(bat_path)
            except:
                pass

            # Verify installation worked
            if is_certificate_installed():
                log('Certificate installation verified successful')

                show_custom_dialog(
                    "Success",
                    "CA certificate installed successfully!\n\n"
                    "Your browser will now trust all certificates from Shipping Manager CoPilot.\n\n"
                    "Please restart your browser for the changes to take effect.",
                    dialog_type='info',
                    buttons=['OK']
                )
                return True
            else:
                log('ERROR: Certificate not found in store after installation')
                raise Exception("Certificate installation appears to have failed (not found in certificate store)")


        elif system == 'Darwin':
            # macOS requires sudo
            show_custom_dialog(
                "Admin Password Required",
                "Installing the certificate requires administrator privileges.\n\n"
                "A dialog will request your password.",
                dialog_type='info',
                buttons=['OK']
            )

            result = subprocess.run(
                ['osascript', '-e',
                 f'do shell script "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain {CA_CERT_PATH}" with administrator privileges'],
                capture_output=True,
                text=True,
                timeout=120
            )

            if result.returncode != 0:
                raise Exception(f"security command failed: {result.stderr}")

            show_custom_dialog(
                "Success",
                "CA certificate installed successfully!\n\n"
                "Your browser will now trust all certificates from Shipping Manager CoPilot.",
                dialog_type='info',
                buttons=['OK']
            )
            return True

        elif system == 'Linux':
            # Linux requires sudo
            show_custom_dialog(
                "Admin Password Required",
                "Installing the certificate requires root privileges.\n\n"
                "A terminal command will run and request your password.",
                dialog_type='info',
                buttons=['OK']
            )

            # Copy certificate to ca-certificates directory
            subprocess.run(
                ['pkexec', 'cp', str(CA_CERT_PATH), '/usr/local/share/ca-certificates/shipping-manager-copilot-ca.crt'],
                check=True,
                timeout=120
            )

            # Update ca-certificates
            subprocess.run(
                ['pkexec', 'update-ca-certificates'],
                check=True,
                timeout=120
            )

            show_custom_dialog(
                "Success",
                "CA certificate installed successfully!\n\n"
                "Your browser will now trust all certificates from Shipping Manager CoPilot.",
                dialog_type='info',
                buttons=['OK']
            )
            return True

        else:
            show_custom_dialog(
                "Unsupported Platform",
                f"Certificate installation is not supported on {system}.",
                dialog_type='error',
                buttons=['OK']
            )
            return False

    except subprocess.TimeoutExpired:
        show_custom_dialog(
            "Timeout",
            "Certificate installation timed out.\nPlease try again.",
            dialog_type='error',
            buttons=['OK']
        )
        return False
    except Exception as e:
        show_custom_dialog(
            "Installation Failed",
            f"Failed to install certificate:\n{str(e)}\n\n"
            "You can install it manually using the Download option.",
            dialog_type='error',
            buttons=['OK']
        )
        return False

def uninstall_certificates(silent=False):
    """
    Uninstall ALL Shipping Manager CoPilot certificates from system trust store.

    Args:
        silent: If True, don't show confirmation dialogs

    Returns:
        bool: True if successful, False otherwise
    """
    log('uninstall_certificates() called')

    # Get all installed certificates
    installed_certs = get_all_installed_certificates()
    log(f'Found {len(installed_certs)} installed certificates')

    if not installed_certs:
        log('No certificates found')
        if not silent:
            show_custom_dialog(
                "No Certificates Found",
                "No Shipping Manager CoPilot certificates found in the system trust store.",
                dialog_type='info',
                buttons=['OK']
            )
        return True

    # Confirm uninstallation
    if not silent:
        log('Showing confirmation dialog')

        cert_list = "\n".join([f"  • {cert}" for cert in installed_certs[:5]])
        if len(installed_certs) > 5:
            cert_list += "\n  ..."

        response = show_custom_dialog(
            "Confirm Uninstallation",
            f"Found {len(installed_certs)} Shipping Manager CoPilot certificate(s):\n\n"
            + cert_list
            + "\n\nDo you want to remove ALL of them?",
            dialog_type='question',
            buttons=['Yes', 'No']
        )

        log(f'User response: {response}')
        if response != 'Yes':
            log('User cancelled')
            return False

    system = platform.system()
    removed_count = 0
    log(f'Platform: {system}')

    try:
        if system == 'Windows':
            log('Windows: Starting certificate removal')

            # Show UAC info
            if not silent:
                log('Showing UAC info dialog')

                show_custom_dialog(
                    "Admin Rights Required",
                    "Uninstalling certificates requires administrator privileges.\n\n"
                    "A User Account Control (UAC) dialog will appear.\n"
                    "Please click 'Yes' to allow the uninstallation.",
                    dialog_type='info',
                    buttons=['OK']
                )

            # Remove each certificate using certutil
            # We need to use the certificate hash to delete it
            log('Running certutil -store Root to list certificates')

            result = subprocess.run(
                ['certutil', '-store', 'Root'],
                capture_output=True,
                text=True,
                timeout=30
            )

            log(f'certutil returned: {result.returncode}')

            if result.returncode == 0:
                lines = result.stdout.split('\n')
                found_our_cert = False
                cert_hashes = []

                log(f'Parsing {len(lines)} lines of output')

                # FIRST: Collect all hashes
                for i, line in enumerate(lines):
                    # Look for our certificates first (CN check)
                    if 'CN=Shipping Manager CoPilot CA' in line or 'CN=Shipping Manager Chat CA' in line:
                        log(f'Found our certificate in line {i}: {line.strip()}')
                        found_our_cert = True

                    # If we found our cert, look for the hash in the NEXT lines
                    elif found_our_cert and '(sha1):' in line and not line.strip().startswith('--'):
                        # Extract hash after "(sha1): "
                        cert_hash = line.split('(sha1):', 1)[1].strip()
                        log(f'Found hash for certificate: {cert_hash}')
                        cert_hashes.append(cert_hash)
                        found_our_cert = False

                log(f'Collected {len(cert_hashes)} certificate hashes to delete')

                # SECOND: Delete all certificates in ONE batch with ONE UAC dialog
                if cert_hashes:
                    try:
                        import tempfile
                        import ctypes

                        # Create a batch file that deletes all certificates
                        batch_content = '@echo off\n'
                        for cert_hash in cert_hashes:
                            batch_content += f'certutil -delstore Root {cert_hash}\n'

                        # Write to temp file
                        with tempfile.NamedTemporaryFile(mode='w', suffix='.bat', delete=False) as bat_file:
                            bat_file.write(batch_content)
                            bat_path = bat_file.name

                        log(f'Created batch file: {bat_path}')
                        log(f'Batch file will delete {len(cert_hashes)} certificates')
                        log(f'Calling ShellExecuteW with ONE UAC dialog...')

                        # Execute batch file with ONE UAC prompt
                        ret = ctypes.windll.shell32.ShellExecuteW(
                            None,                          # hwnd
                            "runas",                       # operation (triggers UAC)
                            bat_path,                      # file
                            "",                            # parameters
                            None,                          # directory
                            1                              # SW_SHOWNORMAL
                        )

                        log(f'ShellExecuteW returned: {ret}')

                        # Wait for batch to complete
                        import time
                        time.sleep(2)

                        # Clean up batch file
                        try:
                            os.unlink(bat_path)
                        except:
                            pass

                        # ShellExecute returns >32 on success
                        if ret > 32:
                            log(f'Batch execution successful')
                            removed_count = len(cert_hashes)
                        else:
                            log(f'ERROR: ShellExecute failed with code {ret}')

                    except Exception as e:
                        log(f'ERROR: Exception during batch deletion: {e}')

                log(f'Finished processing all certificates. Removed: {removed_count}')

        elif system == 'Darwin':
            # macOS - delete certificates from System keychain
            if not silent:
                show_custom_dialog(
                    "Admin Password Required",
                    "Uninstalling certificates requires administrator privileges.\n\n"
                    "A dialog will request your password.",
                    dialog_type='info',
                    buttons=['OK']
                )

            for cert_name in installed_certs:
                try:
                    result = subprocess.run(
                        ['osascript', '-e',
                         f'do shell script "security delete-certificate -c \\"{cert_name}\\" /Library/Keychains/System.keychain" with administrator privileges'],
                        capture_output=True,
                        text=True,
                        timeout=60
                    )
                    if result.returncode == 0:
                        removed_count += 1
                except Exception as e:
                    print(f"[Certificate Manager] Failed to delete certificate {cert_name}: {e}", file=sys.stderr)

        elif system == 'Linux':
            # Linux - remove from ca-certificates
            if not silent:
                show_custom_dialog(
                    "Admin Password Required",
                    "Uninstalling certificates requires root privileges.\n\n"
                    "A terminal command will run and request your password.",
                    dialog_type='info',
                    buttons=['OK']
                )

            for cert_name in installed_certs:
                cert_file = f'/usr/local/share/ca-certificates/{cert_name}.crt'
                try:
                    subprocess.run(
                        ['pkexec', 'rm', '-f', cert_file],
                        check=True,
                        timeout=60
                    )
                    removed_count += 1
                except Exception as e:
                    print(f"[Certificate Manager] Failed to delete certificate {cert_name}: {e}", file=sys.stderr)

            # Update ca-certificates
            if removed_count > 0:
                subprocess.run(
                    ['pkexec', 'update-ca-certificates'],
                    timeout=60
                )

        if not silent:
            log('Showing completion dialog')

            if removed_count > 0:
                log(f'SUCCESS: Removed {removed_count} certificate(s)')
                show_custom_dialog(
                    "Success",
                    f"Successfully removed {removed_count} certificate(s) from the system trust store.\n\n"
                    "Please restart your browser for the changes to take effect.",
                    dialog_type='info',
                    buttons=['OK']
                )
            else:
                log('WARNING: No certificates removed')
                show_custom_dialog(
                    "No Certificates Removed",
                    "Failed to remove certificates. They may have already been removed.",
                    dialog_type='warning',
                    buttons=['OK']
                )

        log(f'Returning: {removed_count > 0}')
        return removed_count > 0

    except Exception as e:
        log(f'EXCEPTION: {e}')

        if not silent:
            show_custom_dialog(
                "Uninstallation Failed",
                f"Failed to uninstall certificates:\n{str(e)}",
                dialog_type='error',
                buttons=['OK']
            )

        return False

def download_certificate():
    """
    Open file save dialog to download the CA certificate.

    Returns:
        bool: True if successful, False otherwise
    """
    if not CA_CERT_PATH.exists():
        messagebox.showerror(
            "Certificate Not Found",
            f"CA certificate not found at:\n{CA_CERT_PATH}\n\n"
            "Please start the application first to generate certificates."
        )
        return False

    # Create hidden root window for file dialog
    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)

    try:
        # Open file save dialog
        save_path = filedialog.asksaveasfilename(
            title="Save CA Certificate",
            defaultextension=".pem",
            filetypes=[
                ("PEM Certificate", "*.pem"),
                ("CRT Certificate", "*.crt"),
                ("All Files", "*.*")
            ],
            initialfile="shipping-manager-copilot-ca.pem",
            parent=root
        )

        if save_path:
            # Copy certificate to selected location
            import shutil
            shutil.copy2(CA_CERT_PATH, save_path)

            messagebox.showinfo(
                "Success",
                f"CA certificate saved to:\n{save_path}\n\n"
                "You can now manually install this certificate in your browser or system trust store.",
                parent=root
            )
            return True
        else:
            # User cancelled
            return False

    except Exception as e:
        messagebox.showerror(
            "Download Failed",
            f"Failed to save certificate:\n{str(e)}",
            parent=root
        )
        return False
    finally:
        root.destroy()

def check_certificate_update_needed():
    """
    Check if certificates need to be updated (new installation detected).

    Returns:
        bool: True if update needed, False otherwise
    """
    # Check if server cert exists but CA is not installed
    server_cert_path = CERTS_DIR / 'cert.pem'

    if server_cert_path.exists() and not is_certificate_installed():
        return True

    return False

def prompt_certificate_installation():
    """
    Show a dialog prompting user to install certificates if needed.

    Returns:
        bool: True if user chose to install, False otherwise
    """
    if not check_certificate_update_needed():
        return False

    response = messagebox.askyesno(
        "Certificate Installation",
        "New certificates have been generated.\n\n"
        "Would you like to install the CA certificate to your system trust store?\n\n"
        "This will prevent browser security warnings when accessing the application.",
        icon=messagebox.QUESTION
    )

    if response:
        return install_certificate()

    return False

if __name__ == '__main__':
    # Test functions when run directly
    print(f"CA Certificate Path: {CA_CERT_PATH}")
    print(f"Certificate exists: {CA_CERT_PATH.exists()}")
    print(f"Certificate installed: {is_certificate_installed()}")

    installed = get_all_installed_certificates()
    print(f"Installed certificates: {len(installed)}")
    for cert in installed:
        print(f"  - {cert}")
