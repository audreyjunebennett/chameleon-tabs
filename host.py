import ctypes
from ctypes import wintypes
import base64

import json
import os
from pathlib import Path
import struct
import sys
import time
from queue import Empty, Queue
from io import BytesIO

import win32con as c
import win32gui as g
import win32process
from isolation import verify_hidden_desktop

def read():
    pipe = sys.stdin.buffer
    while header := pipe.read(4):
        if len(header) != 4:
            break
        length = struct.unpack("<I", header)[0]
        if not 0 < length <= 4096:
            break
        data = pipe.read(length)
        if len(data) != length:
            break
        yield json.loads(data)

def renderer(browser, include_hidden=False):
    candidates = []
    def collect(hwnd, _):
        if g.GetClassName(hwnd) == "Chrome_RenderWidgetHostHWND":
            left, top, right, bottom = g.GetWindowRect(hwnd)
            width,height = right-left,bottom-top
            if width > 100 and height > 100 and (include_hidden or g.IsWindowVisible(hwnd)):
                candidates.append((left, top, right, bottom))
        return True
    g.EnumChildWindows(browser, collect, None)
    return candidates[0] if len(candidates) == 1 else None

def below_browser(app, browser):
    current = g.GetWindow(browser,c.GW_HWNDNEXT)
    while current:
        if current == app:
            return True
        current = g.GetWindow(current,c.GW_HWNDNEXT)
    return False

def directly_above(browser):
    previous = g.GetWindow(browser,c.GW_HWNDPREV)
    # A normal app belongs just above Chrome in the normal z-order band.
    if not previous or g.GetWindowLong(previous,c.GWL_EXSTYLE) & c.WS_EX_TOPMOST:
        return c.HWND_TOP
    return previous

def identity(hwnd):
    if g.IsWindow(hwnd):
        return tuple(win32process.GetWindowThreadProcessId(hwnd))
    return None

def rect_region(rect):
    create = ctypes.windll.gdi32.CreateRectRgn
    create.restype = wintypes.HANDLE
    region = create(*rect)
    if not region:
        raise RuntimeError("Windows could not allocate a clip region.")
    return region

def saved_region(hwnd):
    region = rect_region((0,0,0,0))
    try:
        get_region = ctypes.windll.user32.GetWindowRgn
        get_region.argtypes = (wintypes.HWND, wintypes.HANDLE)
        if not get_region(hwnd, region):
            return None
        read_region = ctypes.windll.gdi32.GetRegionData
        size = read_region(ctypes.c_void_p(region), 0, None)
        buffer = ctypes.create_string_buffer(size)
        if not size or read_region(ctypes.c_void_p(region),size,buffer) != size:
            raise RuntimeError("Windows could not save the app's original clip region.")
        return base64.b64encode(buffer.raw).decode("ascii")
    finally:
        g.DeleteObject(region)

def apply_region(hwnd, original, clip=None):
    region = 0
    if original:
        create = ctypes.windll.gdi32.ExtCreateRegion
        create.restype = wintypes.HANDLE
        data = base64.b64decode(original)
        region = create(None,len(data),data)
        if not region:
            raise RuntimeError("Windows could not recreate the app's clip region.")
    try:
        if clip is not None:
            limit = rect_region(clip)
            if region:
                try:
                    if not g.CombineRgn(region, region, limit, c.RGN_AND):
                        raise RuntimeError("Windows could not combine the clip regions.")
                finally:
                    g.DeleteObject(limit)
            else:
                region = limit
        set_region = ctypes.windll.user32.SetWindowRgn
        set_region.argtypes = (wintypes.HWND, wintypes.HANDLE, wintypes.BOOL)
        if not set_region(hwnd, region, True):
            raise RuntimeError("Windows could not clip this app window.")
        region = 0  # Windows owns the region after SetWindowRgn succeeds.
    finally:
        if region:
            g.DeleteObject(region)

def restore_window(state, minimize=False):
    hwnd = state["handle"]
    if identity(hwnd) != (state["thread"], state["pid"]):
        return
    if state.get("clip_managed"):
        g.ShowWindow(hwnd,c.SW_HIDE)
        apply_region(hwnd,state.get("original_region"))
    if "ex_style" in state and g.GetWindowLong(hwnd,c.GWL_EXSTYLE) != state["ex_style"]:
        g.ShowWindow(hwnd,c.SW_HIDE)
        g.SetWindowLong(hwnd,c.GWL_EXSTYLE,state["ex_style"])
    # Placement restores visibility through USER so Explorer sees the transition.
    visible = g.GetWindowLong(hwnd,c.GWL_STYLE) & c.WS_VISIBLE
    style = (state["style"] & ~c.WS_VISIBLE) | visible
    flags, show, minimum, maximum, normal = state["placement"]
    if minimize:
        style &= ~(c.WS_MINIMIZE | c.WS_MAXIMIZE)
        if show == c.SW_SHOWMAXIMIZED:
            flags |= 2  # WPF_RESTORETOMAXIMIZED
        show = c.SW_SHOWMINNOACTIVE
    g.SetWindowLong(hwnd, c.GWL_STYLE, style)
    g.SetWindowPlacement(hwnd, (flags, show, tuple(minimum), tuple(maximum), tuple(normal)))
    g.SetWindowPos(hwnd, 0, 0, 0, 0, 0, c.SWP_FRAMECHANGED | c.SWP_NOACTIVATE |
                   c.SWP_NOMOVE | c.SWP_NOSIZE | c.SWP_NOZORDER)

def process_path(pid):
    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.restype = ctypes.c_void_p
    process = kernel.OpenProcess(0x1000, False, pid)
    if not process:
        return ""
    try:
        path = ctypes.create_unicode_buffer(32768)
        length = ctypes.c_ulong(len(path))
        if kernel.QueryFullProcessImageNameW(ctypes.c_void_p(process), 0, path, ctypes.byref(length)):
            return path.value
        return ""
    finally:
        kernel.CloseHandle(ctypes.c_void_p(process))

def process_name(pid):
    return Path(process_path(pid)).name.lower()

def window_icon(hwnd, pid):
    from PIL import Image
    user = ctypes.windll.user32
    send_message = user.SendMessageTimeoutW
    send_message.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                             wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t))
    icon = ctypes.c_size_t()
    for size in (2, 0, 1):
        if send_message(hwnd, 0x7F, size, 0, 2, 60, ctypes.byref(icon)) and icon.value:
            break
        icon.value = 0
    if not icon.value:
        get_class = user.GetClassLongPtrW
        get_class.argtypes = (wintypes.HWND, ctypes.c_int)
        get_class.restype = ctypes.c_size_t
        icon.value = get_class(hwnd, -34) or get_class(hwnd, -14)
    owned = []
    try:
        if not icon.value:
            path = process_path(pid)
            if path:
                large, small = g.ExtractIconEx(path, 0, 1)
                owned = large + small
                icon.value = next(iter(small or large), 0)
        if not icon.value:
            return None
        # Render on black and white to recover transparency even for icons with legacy masks.
        import win32ui
        side = 32
        screen = g.GetDC(0)
        source = win32ui.CreateDCFromHandle(screen)
        memory = source.CreateCompatibleDC()
        bitmap = win32ui.CreateBitmap()
        bitmap.CreateCompatibleBitmap(source, side, side)
        previous = memory.SelectObject(bitmap)
        try:
            pixels = []
            for background in (0, 255):
                memory.FillSolidRect((0, 0, side, side), background * 0x010101)
                g.DrawIconEx(memory.GetSafeHdc(), 0, 0, icon.value, side, side, 0, None, 3)
                pixels.append(Image.frombytes("RGB", (side, side), bitmap.GetBitmapBits(True), "raw", "BGRX").tobytes())
            rgba = bytearray()
            for i in range(0, len(pixels[0]), 3):
                black, white = (row[i:i+3] for row in pixels)
                alpha = max(0, min(255, 255 - max(b-a for a,b in zip(black, white))))
                rgba.extend(min(255, round(value*255/alpha)) if alpha else 0 for value in black)
                rgba.append(alpha)
            image = Image.frombytes("RGBA", (side, side), bytes(rgba))
            if process_name(pid) == "chatgpt.exe":
                # The native icon is a white glyph on transparency. Keep its mask
                # and give Chrome a dark glyph for light-colored tab bars.
                alpha = image.getchannel("A")
                image = Image.new("RGBA", image.size, "#202124")
                image.putalpha(alpha)
            stream = BytesIO()
            image.save(stream, format="PNG")
            return "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode("ascii")
        finally:
            memory.SelectObject(previous)
            g.DeleteObject(bitmap.GetHandle())
            memory.DeleteDC()
            g.ReleaseDC(0, screen)
    finally:
        for handle in owned:
            g.DestroyIcon(handle)

def find_browser(marker=None):
    parent_arg = next((arg.split("=",1)[1] for arg in sys.argv if arg.startswith("--parent-window=")), "0")
    parent = int(parent_arg)
    candidates = []
    def collect(hwnd, _):
        if (g.IsWindowVisible(hwnd) and not g.GetWindow(hwnd,c.GW_OWNER)
                and g.GetClassName(hwnd) == "Chrome_WidgetWin_1"
                and g.GetWindowLong(hwnd,c.GWL_STYLE) & c.WS_SYSMENU
                and process_name(identity(hwnd)[1]) == "chrome.exe"):
            candidates.append(hwnd)
        return True
    g.EnumWindows(collect, None)
    if marker:
        return next((hwnd for hwnd in candidates if marker in g.GetWindowText(hwnd)), None)
    foreground = g.GetForegroundWindow()
    root_owner = ctypes.windll.user32.GetAncestor(foreground,3) if foreground else 0
    if root_owner in candidates:
        return root_owner
    if foreground in candidates:
        return foreground
    if parent in candidates:
        return parent
    if len(candidates) == 1:
        return candidates[0]
    raise RuntimeError("Click the extension button again from the Chrome window you want to use.")

def list_windows(browser):
    _, browser_pid = identity(browser)
    windows = []
    def collect(hwnd, _):
        title = g.GetWindowText(hwnd).strip()
        if (title and g.IsWindowVisible(hwnd)
                and not g.GetWindow(hwnd, c.GW_OWNER)
                and not g.GetWindowLong(hwnd, c.GWL_EXSTYLE) & (c.WS_EX_TOOLWINDOW | c.WS_EX_TOPMOST)
                and not g.GetWindowLong(hwnd, c.GWL_STYLE) & c.WS_CHILD):
            tid, pid = identity(hwnd)
            cloaked = ctypes.c_int()
            ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(cloaked), 4)
            # Electron apps also use Chrome_WidgetWin_1. Exclude the actual browser processes.
            executable = process_name(pid)
            if pid != browser_pid and executable and executable not in {"chrome.exe","msedge.exe"} and not cloaked.value:
                windows.append(dict(handle=hwnd, pid=pid, thread=tid, label=title[:100]))
        return True
    def collect_window(hwnd, arg):
        try:
            return collect(hwnd, arg)
        except Exception:
            return True  # A window may disappear during enumeration.
    g.EnumWindows(collect_window, None)
    return windows[:100]

def send(msg):
    body = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I",len(body)) + body)
    sys.stdout.buffer.flush()

def recover(journal):
    if journal.exists():
        saved = json.loads(journal.read_text(encoding="utf-8"))
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        process = kernel.OpenProcess(0x100000, False, saved["helperPid"])
        if process:
            try:
                if kernel.WaitForSingleObject(ctypes.c_void_p(process),0) == 258:
                    raise RuntimeError("The app-tabs helper is already running.")
            finally:
                kernel.CloseHandle(ctypes.c_void_p(process))
        for window in saved["windows"]:
            restore_window(window)
        journal.unlink()

def update_window(state, browser, bounds):
    app = state["handle"]
    if not bounds:
        if g.IsWindowVisible(app):
            g.ShowWindow(app,c.SW_HIDE)
        return
    left, top, right, bottom = bounds
    size = right-left, bottom-top
    flags = c.SWP_NOACTIVATE
    if not state.get("modified"):
        # Clear the maximized/minimized state through placement, before changing the frame.
        # SW_SHOWNOACTIVATE can leave an already visible maximized window maximized.
        if g.IsIconic(app) or ctypes.windll.user32.IsZoomed(app):
            _, _, minimum, maximum, normal = state["placement"]
            g.SetWindowPlacement(app,(0,c.SW_SHOWNORMAL,minimum,maximum,normal))
            if g.IsIconic(app) or ctypes.windll.user32.IsZoomed(app):
                g.ShowWindow(app,c.SW_RESTORE)
            if g.IsIconic(app) or ctypes.windll.user32.IsZoomed(app):
                raise RuntimeError("Windows could not restore this app to a resizable window.")
        # Use the current style. The saved style can include WS_MAXIMIZE or WS_MINIMIZE.
        style = g.GetWindowLong(app,c.GWL_STYLE)
        # Explorer reevaluates taskbar eligibility when the window is shown again.
        g.ShowWindow(app,c.SW_HIDE)
        ex_style = g.GetWindowLong(app,c.GWL_EXSTYLE)
        g.SetWindowLong(app,c.GWL_EXSTYLE,(ex_style & ~c.WS_EX_APPWINDOW) | c.WS_EX_TOOLWINDOW)
        g.SetWindowLong(app,c.GWL_STYLE,style & ~(c.WS_CAPTION | c.WS_THICKFRAME | c.WS_VISIBLE))
        state["modified"] = True
        flags |= c.SWP_FRAMECHANGED
    actual = g.GetWindowRect(app)
    changed = state.get("applied_bounds") != bounds or state.get("actual_bounds") != actual
    if changed:
        # Keep the app visible during a resize. Chromium-based apps can leave their
        # content at the old surface size if we hide them while resizing the frame.
        if (size[0] < actual[2]-actual[0] or size[1] < actual[3]-actual[1]) and g.IsWindowVisible(app):
            limit = (0,0,min(size[0],actual[2]-actual[0]),min(size[1],actual[3]-actual[1]))
            if limit != state.get("clip"):
                apply_region(app,state["original_region"],limit)
                state["clip"] = limit
        anchor = directly_above(browser)
        order = c.SWP_NOZORDER if anchor == app else 0
        g.SetWindowPos(app,anchor,left,top,*size,order | flags)
        actual = g.GetWindowRect(app)
        x,y,r,b = actual
        visible = (max(left,x),max(top,y),min(right,r),min(bottom,b))
        if visible[0] >= visible[2] or visible[1] >= visible[3]:
            g.ShowWindow(app,c.SW_HIDE)
            return
        clip = (visible[0]-x,visible[1]-y,visible[2]-x,visible[3]-y) if actual != visible else None
        if clip != state.get("clip"):
            apply_region(app,state["original_region"],clip)
            state["clip"] = clip
        state["applied_bounds"],state["actual_bounds"] = bounds,actual
    showing = not g.IsWindowVisible(app)
    if showing:
        g.SetWindowPos(app,0,0,0,0,0,c.SWP_SHOWWINDOW | c.SWP_NOACTIVATE |
                       c.SWP_NOMOVE | c.SWP_NOSIZE | c.SWP_NOZORDER)
    if changed or showing:
        g.RedrawWindow(app,None,None,c.RDW_INVALIDATE | c.RDW_ALLCHILDREN)
    if below_browser(app,browser):
        g.SetWindowPos(app,directly_above(browser),0,0,0,0,c.SWP_NOACTIVATE | c.SWP_NOMOVE | c.SWP_NOSIZE)

def main():
    from threading import Thread
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    root = Path(__file__).resolve().parent
    journal = root/"restore-windows.json"
    recover(journal)
    if sys.argv[1:] == ["--recover"]:
        return
    config_path = root/"fixture.json"
    if config_path.is_file():
        config = json.loads(config_path.read_text(encoding="utf-8"))
        os.environ["OFFSTAGE_DESKTOP"] = config["desktop"]
        verify_hidden_desktop()
        browser = config["chrome"]
        if identity(browser)[1] != config["chromePid"]:
            raise RuntimeError("Test Chrome window identity changed")
    else:
        browser = None
    messages = Queue()
    def receive():
        try:
            for msg in read():
                messages.put(msg)
        finally:
            messages.put(None)
    Thread(target=receive, daemon=True).start()
    states = {}
    active_tabs = {}
    selected_window_id = None
    listed_browsers = {}

    def save():
        if states:
            tmp = journal.with_suffix(".tmp")
            tmp.write_text(json.dumps(dict(helperPid=os.getpid(),windows=list(states.values()))),encoding="utf-8")
            tmp.replace(journal)
        else:
            journal.unlink(missing_ok=True)

    def detach(tab, minimize=False):
        state = states.get(tab)
        if state:
            restore_window(state,minimize)
            window_id = state.get("window_id")
            if active_tabs.get(window_id) == tab:
                active_tabs.pop(window_id,None)
            del states[tab]
            save()

    def bounds_for(state):
        chrome = state["browser"]
        if not g.IsWindowVisible(chrome) or g.IsIconic(chrome):
            return None
        bounds = renderer(chrome)
        left, top, right, bottom = g.GetClientRect(chrome)
        left, top = g.ClientToScreen(chrome, (left,top))
        right, bottom = g.ClientToScreen(chrome, (right,bottom))
        size = state.get("viewport")
        toolbar_height = state.get("toolbar_height")
        if bounds:
            x,y,r,b = bounds
            # A stale renderer can already report the new origin but keep the old
            # height. Reject partial surfaces before updating the native clip.
            if abs(x-left) <= 2 and abs(r-right) <= 2 and top <= y < b and abs(b-bottom) <= 2:
                state["toolbar_height"] = y-top
                return max(x,left),y,min(r,right),min(b,bottom)
        if not size or toolbar_height is None:
            return None
        # A covered renderer can keep its current bounds even while marked hidden.
        covered = renderer(chrome,include_hidden=True)
        if covered:
            x,y,r,b = covered
            if abs(x-left) <= 2 and abs(r-right) <= 2 and top+toolbar_height-2 <= y < b and abs(b-bottom) <= 2:
                return covered
        # Chrome can discard the renderer HWND when covered. The extension page
        # still reports its physical size, and the viewport ends at the client bottom.
        width, height = size
        x, y = left, bottom-height
        # A viewport report can be in flight during a resize.
        # Reject stale dimensions before they can cover browser controls.
        if width < 100 or height < 100 or abs(width-(right-left)) > 2 or y < top + toolbar_height - 2:
            return None
        return x, y, min(x+width,right), bottom

    def refresh():
        visible = []
        for tab, state in list(states.items()):
            if identity(state["handle"]) != (state["thread"],state["pid"]):
                detach(tab)
                continue
            chrome = state.get("browser")
            window_id = state.get("window_id")
            if chrome and identity(chrome) != tuple(state["browser_identity"]):
                update_window(state,chrome,None)
                continue  # Chrome may remove the source window during a tab move.
            bounds = bounds_for(state) if chrome and active_tabs.get(window_id) == tab else None
            if bounds:
                visible.append((tab,state,chrome,bounds))
            else:
                update_window(state,chrome,None)
        for tab,state,chrome,bounds in visible:
            try:
                update_window(state,chrome,bounds)
            except Exception as error:
                print(f"Window update failed: {error}",file=sys.stderr)
                detach(tab)

    try:
        while True:
            try:
                msg = messages.get(timeout=0.05 if states else 0.5)
            except Empty:
                try:
                    refresh()
                except Exception as error:
                    print(f"Window update failed: {error}",file=sys.stderr)
                continue
            if msg is None:
                break
            reply = {"id": msg["id"]}
            try:
                command, tab = msg["command"], msg.get("tab")
                if command == "list":
                    requested = msg.get("windowId")
                    known = next((state["browser"] for state in states.values()
                                  if state.get("window_id") == requested and state.get("browser")),None)
                    chrome = known or (browser if config_path.is_file() and browser else find_browser())
                    listed_browsers[requested] = chrome, identity(chrome)
                    windows = list_windows(chrome)
                    used = {state["handle"] for state in states.values()}
                    reply["result"] = [window for window in windows if window["handle"] not in used]
                elif command == "windowIcons":
                    chrome, chrome_identity = listed_browsers.get(msg.get("windowId"), (None, None))
                    requested = msg.get("windows")
                    if not isinstance(requested, list) or len(requested) > 6:
                        raise ValueError("Invalid window icon request.")
                    icons = {}
                    if chrome and identity(chrome) == chrome_identity:
                        available = {window["handle"]: window for window in list_windows(chrome)}
                        for entry in requested:
                            if not isinstance(entry, dict) or type(entry.get("handle")) is not int:
                                continue
                            handle = entry["handle"]
                            item = available.get(handle)
                            if item and all(item[key] == entry.get(key) for key in ("pid", "thread")):
                                try:
                                    icons[handle] = window_icon(handle, item["pid"])
                                except Exception as error:
                                    print(f"Window icon unavailable: {error}", file=sys.stderr)
                    reply["result"] = icons
                elif command == "detach":
                    detach(tab,minimize=msg.get("minimize") is True)
                elif command == "attach":
                    window_id = msg.get("windowId")
                    chrome, chrome_identity = listed_browsers.get(window_id,(None,None))
                    if not chrome or identity(chrome) != chrome_identity:
                        raise ValueError("Reopen the picker in this Chrome window.")
                    if type(tab) is not int or tab in states:
                        raise ValueError("Invalid app tab.")
                    item = next((w for w in list_windows(chrome) if all(w[k] == msg.get(k) for k in ("handle","pid","thread"))), None)
                    if not item or any(w["handle"] == item["handle"] for w in states.values()):
                        raise ValueError("That window is no longer available.")
                    app = item["handle"]
                    states[tab] = dict(item, style=g.GetWindowLong(app,c.GWL_STYLE),
                                       clip_managed=True,original_region=saved_region(app),
                                       ex_style=g.GetWindowLong(app,c.GWL_EXSTYLE), placement=g.GetWindowPlacement(app),
                                       browser=chrome,browser_identity=chrome_identity,window_id=window_id)
                    try:
                        save()
                    except Exception:
                        del states[tab]
                        raise
                    try:
                        reply["result"] = window_icon(app, item["pid"])
                    except Exception as error:
                        print(f"Window icon unavailable: {error}", file=sys.stderr)
                elif command == "suspend" and tab in states:
                    state = states[tab]
                    window_id = state.pop("window_id",None)
                    if active_tabs.get(window_id) == tab:
                        active_tabs.pop(window_id,None)
                    state["browser"] = None
                    refresh()
                elif command == "move" and tab in states:
                    marker = msg.get("marker","")
                    if not marker.startswith("DesktopAppTabs-"):
                        raise ValueError("Invalid Chrome window marker.")
                    deadline = time.monotonic()+1.25
                    while not (chrome := find_browser(marker)):
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Could not locate the destination Chrome window. Select the app tab to retry.")
                        time.sleep(.05)
                    states[tab].pop("toolbar_height",None)
                    states[tab].update(browser=chrome,browser_identity=identity(chrome),window_id=msg["windowId"])
                elif command == "viewport" and tab in states:
                    width,height = msg.get("width"),msg.get("height")
                    if all(type(value) is int and 0 < value < 32768 for value in (width,height)):
                        states[tab]["viewport"] = (width,height)
                        refresh()
                elif command == "active":
                    window_id = msg.get("windowId")
                    if tab in states and states[tab].get("window_id") == window_id:
                        active_tabs[window_id] = tab
                    else:
                        active_tabs.pop(window_id,None)
                    refresh()
                else:
                    raise ValueError("Unknown command.")
            except Exception as error:
                reply["error"] = str(error)
            send(reply)
    finally:
        for tab in list(states):
            try:
                detach(tab)
            except Exception as error:
                print(error,file=sys.stderr)

if __name__ == "__main__":
    main()


