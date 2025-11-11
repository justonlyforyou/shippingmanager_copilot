# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for building start.py as a single executable.
This bundles all Python helper scripts internally.
Usage: pyinstaller build-start.spec
"""

import os

block_cipher = None

# Get the directory containing this spec file
spec_root = os.path.dirname(os.path.abspath(SPECPATH))

a = Analysis(
    ['../start.py'],
    pathex=[],
    binaries=[
        ('../dist/ShippingManagerCoPilot-Server.exe', '.'),  # Embed Node.js server exe
        ('../dist/session-selector.exe', 'helper'),  # Dialog executables with icon
        ('../dist/login-dialog.exe', 'helper'),
        ('../dist/expired-sessions-dialog.exe', 'helper'),
    ],
    datas=[
        ('../public/favicon.ico', 'public'),
        ('../helper/get_session_windows.py', 'helper'),  # Only Python module (imported by start.py)
        ('../helper/certificate_manager.py', 'helper'),  # Certificate management module
        ('../helper/__init__.py', 'helper'),
    ],
    hiddenimports=[
        'win32crypt',
        'win32api',
        'cryptography',
        'selenium',
        'PIL',
        'tkinter',
        'subprocess',
        'webbrowser',
        'threading',
        'requests',
        'keyring',
        'sqlite3',
        'get_session_windows',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='ShippingManagerCoPilot',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # No console window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=os.path.join(spec_root, 'helper', 'installer', 'icon.ico')
)
