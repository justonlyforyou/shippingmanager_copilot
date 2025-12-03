# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for building start.py as a single executable.
Cross-platform version (macOS/Linux) - uses browser-only session management.

Usage: pyinstaller build-start-crossplatform.spec
"""

import os
import platform

block_cipher = None

# Get the directory containing this spec file
spec_root = os.path.dirname(os.path.abspath(SPECPATH))

# Platform-specific settings
system = platform.system()

# Executable extension
exe_ext = '' if system != 'Windows' else '.exe'

# Icon file
if system == 'Darwin':
    icon_file = os.path.join(spec_root, 'helper', 'installer', 'icon.icns') if os.path.exists(os.path.join(spec_root, 'helper', 'installer', 'icon.icns')) else None
else:
    icon_file = None  # Linux doesn't use icons in executables

# On macOS, we create a .app bundle
# On Linux, we create a standalone executable

# Binaries to embed (cross-platform helper executables)
binaries_list = [
    (f'../dist/ShippingManagerCoPilot-Server{exe_ext}', '.'),
    (f'../dist/session-selector{exe_ext}', 'helper'),
    (f'../dist/login-dialog{exe_ext}', 'helper'),
    (f'../dist/expired-sessions-dialog{exe_ext}', 'helper'),
]

# Data files
datas_list = [
    ('../public/favicon.ico', 'public'),
    ('../helper/get_session.py', 'helper'),  # Cross-platform session module
    ('../helper/certificate_manager.py', 'helper'),
    ('../helper/__init__.py', 'helper'),
]

# Hidden imports (cross-platform)
hidden_imports = [
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
    'pystray',
]

# Platform-specific keyring backends
if system == 'Darwin':
    hidden_imports.extend([
        'keyring.backends.macOS',
        'keyring.backends.OS_X',
    ])
elif system == 'Linux':
    hidden_imports.extend([
        'keyring.backends.SecretService',
    ])

a = Analysis(
    ['../start.py'],
    pathex=[],
    binaries=binaries_list,
    datas=datas_list,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

if system == 'Darwin':
    # macOS: Create .app bundle
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name='ShippingManagerCoPilot',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        console=False,  # No console window on macOS
        disable_windowed_traceback=False,
        argv_emulation=True,  # Enable argv emulation for macOS
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon=icon_file
    )

    coll = COLLECT(
        exe,
        a.binaries,
        a.zipfiles,
        a.datas,
        strip=False,
        upx=True,
        upx_exclude=[],
        name='ShippingManagerCoPilot'
    )

    app = BUNDLE(
        coll,
        name='ShippingManagerCoPilot.app',
        icon=icon_file,
        bundle_identifier='com.shippingmanager.copilot',
        info_plist={
            'CFBundleName': 'Shipping Manager CoPilot',
            'CFBundleDisplayName': 'Shipping Manager CoPilot',
            'CFBundleGetInfoString': 'Shipping Manager CoPilot',
            'CFBundleIdentifier': 'com.shippingmanager.copilot',
            'CFBundleVersion': '0.1.6.1',
            'CFBundleShortVersionString': '0.1.6.1',
            'NSHighResolutionCapable': True,
            'LSUIElement': False,  # Show in dock
        }
    )
else:
    # Linux: Create single executable
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
        icon=icon_file
    )
