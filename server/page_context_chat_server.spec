# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Page Context Chat local server.

构建（在项目根目录执行）：

    python -m PyInstaller --noconfirm --clean `
        --distpath server/dist --workpath server/build `
        server/page_context_chat_server.spec

产物：server/dist/page-context-chat-server.exe（单文件、带控制台）。
"""

import os

from PyInstaller.utils.hooks import collect_all

PROJECT_ROOT = os.path.abspath(os.path.join(SPECPATH, os.pardir))
ENTRY_SCRIPT = os.path.join(SPECPATH, "server.py")

# aiohttp 大量使用子模块与 C 扩展，collect_all 一次性收集其子模块、二进制和元数据。
aiohttp_datas, aiohttp_binaries, aiohttp_hiddenimports = collect_all("aiohttp")

a = Analysis(
    [ENTRY_SCRIPT],
    pathex=[PROJECT_ROOT],
    binaries=aiohttp_binaries,
    datas=aiohttp_datas,
    hiddenimports=aiohttp_hiddenimports + ["mcp_stdio"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="page-context-chat-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
