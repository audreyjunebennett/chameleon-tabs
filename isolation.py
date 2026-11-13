import ctypes
from ctypes import wintypes
import os

def verify_hidden_desktop():
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.GetThreadDesktop.argtypes = (wintypes.DWORD,)
    user32.GetThreadDesktop.restype = wintypes.HANDLE
    user32.GetUserObjectInformationW.argtypes = (
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    )
    name = ctypes.create_unicode_buffer(256)
    desktop = user32.GetThreadDesktop(kernel32.GetCurrentThreadId())
    if not user32.GetUserObjectInformationW(desktop, 2, name, ctypes.sizeof(name), None):
        raise ctypes.WinError(ctypes.get_last_error())
    expected = os.environ.get("OFFSTAGE_DESKTOP", "")
    if not expected.startswith("offstage-") or name.value != expected:
        raise SystemExit(f"Refusing to launch GUI on desktop {name.value!r}")
    return name.value
