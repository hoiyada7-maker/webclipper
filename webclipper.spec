import sys
import os
from pathlib import Path

# Playwright driver (첫 실행 시 브라우저 설치에 필요)
try:
    import playwright as _pw
    _pw_driver = str(Path(_pw.__file__).parent / "driver")
except ImportError:
    _pw_driver = None

datas = [
    ("templates", "templates"),
    ("static", "static"),
]
if _pw_driver and os.path.isdir(_pw_driver):
    datas.append((_pw_driver, "playwright/driver"))

# winsdk는 Windows 전용 — Linux 빌드에서 제외
excludes = [] if sys.platform == "win32" else ["winsdk"]

block_cipher = None

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[
        # uvicorn 동적 임포트
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        # FastAPI / anyio
        "anyio",
        "anyio._backends",
        "anyio._backends._asyncio",
        "starlette.routing",
        # HTTP transport
        "h11",
        "httptools",
        "websockets",
        "wsproto",
        # Image processing
        "PIL._tkinter_finder",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="webclipper",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,   # 콘솔 창 표시 (로그 확인용)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # exe 옆에 라이브러리를 펼쳐 PATH 참조를 단순하게 유지
    contents_directory=".",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="webclipper",
)
