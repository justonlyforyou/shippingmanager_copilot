# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for compiling cross-platform Python helper scripts.
Used on macOS and Linux (no Steam support, browser-only).

Usage: pyinstaller build-python-crossplatform.spec
"""

import platform
import os

block_cipher = None

# Platform-specific settings
system = platform.system()

# Executable extension
exe_ext = '.exe' if system == 'Windows' else ''

# Icon file (platform-specific)
if system == 'Darwin':
    icon_file = '../helper/installer/icon.icns' if os.path.exists('../helper/installer/icon.icns') else None
elif system == 'Windows':
    icon_file = '../helper/installer/icon.ico'
else:
    icon_file = None  # Linux doesn't use icons in executables

# Console settings
# On macOS, GUI apps need console=False to avoid terminal window
console_setting = False if system == 'Darwin' else False


# =============================================================================
# get_session.py (cross-platform, browser-only)
# =============================================================================
get_session = Analysis(
    ['../helper/get_session.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'cryptography',
        'selenium',
        'selenium.webdriver',
        'selenium.webdriver.chrome.service',
        'selenium.webdriver.firefox.service',
        'selenium.webdriver.chrome.options',
        'selenium.webdriver.firefox.options',
        'selenium.webdriver.safari.options',
        'keyring',
        'keyring.backends',
        'keyring.backends.macOS' if system == 'Darwin' else 'keyring.backends.SecretService',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
    noarchive=False,
)

get_session_pyz = PYZ(get_session.pure, get_session.zipped_data, cipher=block_cipher)

get_session_exe = EXE(
    get_session_pyz,
    get_session.scripts,
    get_session.binaries,
    get_session.zipfiles,
    get_session.datas,
    [],
    name=f'get-session{exe_ext}',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # Session manager needs console output
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=icon_file
)


# =============================================================================
# login_dialog.py
# =============================================================================
login_dialog = Analysis(
    ['../helper/login_dialog.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=['tkinter', 'PIL'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
    noarchive=False,
)

login_dialog_pyz = PYZ(login_dialog.pure, login_dialog.zipped_data, cipher=block_cipher)

login_dialog_exe = EXE(
    login_dialog_pyz,
    login_dialog.scripts,
    login_dialog.binaries,
    login_dialog.zipfiles,
    login_dialog.datas,
    [],
    name=f'login-dialog{exe_ext}',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=console_setting,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=icon_file
)


# =============================================================================
# session_selector.py
# =============================================================================
session_selector = Analysis(
    ['../helper/session_selector.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=['tkinter'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
    noarchive=False,
)

session_selector_pyz = PYZ(session_selector.pure, session_selector.zipped_data, cipher=block_cipher)

session_selector_exe = EXE(
    session_selector_pyz,
    session_selector.scripts,
    session_selector.binaries,
    session_selector.zipfiles,
    session_selector.datas,
    [],
    name=f'session-selector{exe_ext}',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=console_setting,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=icon_file
)


# =============================================================================
# expired_sessions_dialog.py
# =============================================================================
expired_sessions_dialog = Analysis(
    ['../helper/expired_sessions_dialog.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=['tkinter'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
    noarchive=False,
)

expired_sessions_dialog_pyz = PYZ(expired_sessions_dialog.pure, expired_sessions_dialog.zipped_data, cipher=block_cipher)

expired_sessions_dialog_exe = EXE(
    expired_sessions_dialog_pyz,
    expired_sessions_dialog.scripts,
    expired_sessions_dialog.binaries,
    expired_sessions_dialog.zipfiles,
    expired_sessions_dialog.datas,
    [],
    name=f'expired-sessions-dialog{exe_ext}',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=console_setting,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=icon_file
)
