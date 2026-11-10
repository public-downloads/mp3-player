"""Folder Player as a Windows app.

Opens the player in a window of its own, drawn by WebView2 (the web view built into Windows 11), with
its own button on the taskbar. No browser is involved: no Edge, Chrome or Brave window, tab or profile.
The window gets the player's files from this folder through a small server on http://127.0.0.1:8418,
which only this computer can reach. When the window is closed, the server stops too.

    pythonw desktop\\folder_player.py             start it
    python desktop\\folder_player.py --shortcut   add "Folder Player" to the Start menu and the desktop

Playlists, songs and settings are kept in %LOCALAPPDATA%\\Folder Player\\WebView2. Where the window
was, and the colour of its title bar, are kept in %LOCALAPPDATA%\\Folder Player\\window.json.

Needs Python 3.10+ with pywebview (python -m pip install pywebview) and the WebView2 Runtime, which
comes with Windows 11. Audio Grabber starts this file for its "Folder Player" button; its packaged
AudioGrabber.exe runs it with "AudioGrabber.exe --player", so it needs pywebview packed in.
"""

import ctypes
import http.server
import json
import os
import re
import socket
import socketserver
import sys
import threading
import traceback
import urllib.parse
import urllib.request
import uuid
from ctypes import wintypes
from pathlib import Path

NAME = "Folder Player"
APP_ID = "FolderPlayer.App"  # ties the window, its shortcuts and a taskbar pin together as one app
APP_DIR = Path(__file__).resolve().parent.parent
ICON = APP_DIR / "icons" / "icon.ico"
HOST = "127.0.0.1"
# The address is where the window keeps the playlists: a different port would start empty.
# (8417 is left for "python -m http.server 8417", for trying the site out.)
PORT = 8418
URL = f"http://{HOST}:{PORT}/"
DATA_DIR = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / NAME
STORAGE = DATA_DIR / "WebView2"
STATE_FILE = DATA_DIR / "window.json"
WINDOW_SIZE = (1100, 800)  # the first time; after that it opens where it was closed
DEFAULT_COLOR = "#12161c"  # the page's theme-color before a theme is picked
COLOR = re.compile(r"#[0-9a-fA-F]{6}")
# Windows' own list of file types can be wrong (e.g. .js as text/plain), so these are fixed here.
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
}
# Follows the page's theme-color, which the theme picker changes, and hands it to Bridge.title_color.
FOLLOW_THEME = """(() => {
  const meta = document.querySelector('meta[name=theme-color]');
  if (!meta) return;
  const send = () => window.pywebview.api.title_color(meta.content);
  const start = () => { send(); new MutationObserver(send).observe(meta, { attributes: true }); };
  if (window.pywebview && window.pywebview.api && window.pywebview.api.title_color) start();
  else addEventListener('pywebviewready', start, { once: true });
})();"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def send_head(self):
        # Only answer to this computer's own address (not other host names pointed at 127.0.0.1),
        # and never serve hidden files or folders (.git, .claude).
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if self.headers.get("Host") not in (f"{HOST}:{PORT}", f"localhost:{PORT}"):
            self.send_error(403)
            return None
        if any(part.startswith(".") for part in path.replace("\\", "/").split("/")):
            self.send_error(404)
            return None
        # The files are all on this computer, so the window needs no offline copy. Without the
        # service worker, changes to the player show the next time it opens, not the time after.
        if path == "/sw.js":
            self.send_error(404)
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def guess_type(self, path):
        return TYPES.get(Path(path).suffix.lower(), "application/octet-stream")

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, format, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # on Windows it would let two programs share the port

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        socketserver.TCPServer.server_bind(self)  # skips HTTPServer's slow host name lookup
        self.server_name, self.server_port = HOST, PORT


def message(text: str, error: bool = False) -> None:
    ctypes.windll.user32.MessageBoxW(None, text, NAME, 0x10 if error else 0x40)


def player_answering() -> bool:
    """True if Folder Player (not some other program) is already being served on the port."""
    no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with no_proxy.open(URL + "manifest.webmanifest", timeout=3) as response:
            return json.load(response).get("name") == NAME
    except (OSError, ValueError, AttributeError):
        return False


def find_window() -> int:
    """The open Folder Player window, if there is one (not, say, a folder called Folder Player)."""
    user32 = ctypes.windll.user32
    user32.FindWindowExW.restype = wintypes.HWND
    user32.FindWindowExW.argtypes = [wintypes.HWND, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR]
    kind = ctypes.create_unicode_buffer(256)
    window = None
    while window := user32.FindWindowExW(None, window, None, NAME):
        user32.GetClassNameW(wintypes.HWND(window), kind, 256)
        if kind.value.startswith("WindowsForms10.Window"):
            return window
    return 0


def focus_window() -> bool:
    """Bring an open Folder Player window to the front."""
    window = find_window()
    if not window:
        return False
    user32 = ctypes.windll.user32
    if user32.IsIconic(wintypes.HWND(window)):
        user32.ShowWindow(wintypes.HWND(window), 9)  # SW_RESTORE
    user32.SetForegroundWindow(wintypes.HWND(window))
    return True


# ---------- the app's taskbar identity (shell property stores, through COM) ----------

class GUID(ctypes.Structure):
    _fields_ = [("data1", wintypes.DWORD), ("data2", wintypes.WORD), ("data3", wintypes.WORD),
                ("data4", ctypes.c_ubyte * 8)]

    @classmethod
    def of(cls, text: str) -> "GUID":
        u = uuid.UUID(text)
        return cls(u.time_low, u.time_mid, u.time_hi_version, (ctypes.c_ubyte * 8)(*u.bytes[8:]))


class PROPERTYKEY(ctypes.Structure):
    _fields_ = [("fmtid", GUID), ("pid", wintypes.DWORD)]


class PROPVARIANT(ctypes.Structure):  # just enough of one to hold a string (VT_LPWSTR)
    _fields_ = [("vt", wintypes.USHORT), ("reserved", wintypes.USHORT * 3), ("text", ctypes.c_wchar_p),
                ("padding", ctypes.c_void_p)]


VT_LPWSTR = 31
APP_PROPERTIES = "9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"  # System.AppUserModel.*
RELAUNCH_COMMAND, RELAUNCH_ICON, RELAUNCH_NAME, APP_USER_MODEL_ID = 2, 3, 4, 5
IID_PROPERTY_STORE = "886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"
IID_PERSIST_FILE = "0000010B-0000-0000-C000-000000000046"
IID_SHELL_LINK = "000214F9-0000-0000-C000-000000000046"
CLSID_SHELL_LINK = "00021401-0000-0000-C000-000000000046"


def com(obj: ctypes.c_void_p, index: int, *argtypes):
    """Method number `index` of the COM interface `obj`, ready to call with the remaining arguments."""
    vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    method = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, *argtypes)(vtable[index])
    return lambda *args: method(obj, *args)


def query(obj: ctypes.c_void_p, iid: str) -> ctypes.c_void_p:
    out = ctypes.c_void_p()
    com(obj, 0, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))(GUID.of(iid), out)  # QueryInterface
    return out


def release(obj: ctypes.c_void_p) -> None:
    com(obj, 2)()


def set_properties(store: ctypes.c_void_p, values: list[tuple[int, str]]) -> None:
    """Write System.AppUserModel properties (property number, text) to a property store."""
    set_value = com(store, 6, ctypes.POINTER(PROPERTYKEY), ctypes.POINTER(PROPVARIANT))
    for number, text in values:
        set_value(PROPERTYKEY(GUID.of(APP_PROPERTIES), number), PROPVARIANT(VT_LPWSTR, text=text))


def launch_command() -> tuple[Path, str]:
    """The program and arguments that start Folder Player (for its shortcuts and a taskbar pin)."""
    if getattr(sys, "frozen", False):  # inside AudioGrabber.exe
        return Path(sys.executable), "--player"
    python = Path(sys.executable)
    pythonw = python.with_name("pythonw.exe")
    return (pythonw if pythonw.is_file() else python), f'"{Path(__file__).resolve()}"'


def tag_window(window: int) -> None:
    """Give the window the app's own taskbar button, and say what pinning it to the taskbar starts."""
    program, arguments = launch_command()
    store = ctypes.c_void_p()
    ctypes.oledll.shell32.SHGetPropertyStoreForWindow(wintypes.HWND(window),
                                                      ctypes.byref(GUID.of(IID_PROPERTY_STORE)),
                                                      ctypes.byref(store))
    try:
        set_properties(store, [(RELAUNCH_COMMAND, f'"{program}" {arguments}'), (RELAUNCH_NAME, NAME),
                               (RELAUNCH_ICON, f"{ICON},0"), (APP_USER_MODEL_ID, APP_ID)])
    finally:
        release(store)


def write_shortcut(path: Path) -> None:
    """A shortcut that starts Folder Player, tied to the app's taskbar button (so a pinned shortcut and
    the open window share one button)."""
    program, arguments = launch_command()
    ctypes.oledll.ole32.CoInitialize(None)
    link = ctypes.c_void_p()
    ctypes.oledll.ole32.CoCreateInstance(ctypes.byref(GUID.of(CLSID_SHELL_LINK)), None, 1,  # in-process
                                         ctypes.byref(GUID.of(IID_SHELL_LINK)), ctypes.byref(link))
    try:
        com(link, 20, wintypes.LPCWSTR)(str(program))  # SetPath
        com(link, 11, wintypes.LPCWSTR)(arguments)  # SetArguments
        com(link, 9, wintypes.LPCWSTR)(str(APP_DIR))  # SetWorkingDirectory
        com(link, 17, wintypes.LPCWSTR, ctypes.c_int)(str(ICON), 0)  # SetIconLocation
        com(link, 7, wintypes.LPCWSTR)("Music player with ambience and EQ")  # SetDescription
        store = query(link, IID_PROPERTY_STORE)
        try:
            set_properties(store, [(APP_USER_MODEL_ID, APP_ID)])
            com(store, 7)()  # Commit
        finally:
            release(store)
        file = query(link, IID_PERSIST_FILE)
        try:
            com(file, 6, wintypes.LPCWSTR, wintypes.BOOL)(str(path), True)  # Save
        finally:
            release(file)
    finally:
        release(link)


def make_shortcuts() -> None:
    """A "Folder Player" shortcut in the Start menu and on the desktop."""
    folder = ctypes.create_unicode_buffer(260)
    made = []
    for csidl in (0x02, 0x10):  # the Start menu's Programs folder, the desktop
        ctypes.oledll.shell32.SHGetFolderPathW(None, csidl, None, 0, folder)
        made.append(Path(folder.value) / f"{NAME}.lnk")
        write_shortcut(made[-1])
    print("Created:\n  " + "\n  ".join(map(str, made)))


# ---------- the window ----------

class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long),
                ("bottom", ctypes.c_long)]


def on_screen(bounds: list[int]) -> bool:
    """True if the window's title bar would be on a screen, where it can be grabbed (and not, say, on
    a monitor that's since been unplugged)."""
    x, y, width, height = bounds
    title_bar = RECT(x + 40, y, x + width - 40, y + 30)
    return width >= 300 and height >= 300 and bool(ctypes.windll.user32.MonitorFromRect(ctypes.byref(title_bar), 0))


def paint_title_bar(window: int, color: str) -> None:
    """Colour the title bar like the player's theme, with light or dark text and buttons to suit."""
    red, green, blue = (int(color[i:i + 2], 16) for i in (1, 3, 5))
    dark = 0.299 * red + 0.587 * green + 0.114 * blue < 140
    rgb = red | green << 8 | blue << 16
    dwm = ctypes.windll.dwmapi.DwmSetWindowAttribute
    # DWMWA_USE_IMMERSIVE_DARK_MODE, _BORDER_COLOR, _CAPTION_COLOR, _TEXT_COLOR
    for attribute, value in ((20, int(dark)), (34, rgb), (35, rgb), (36, 0xFFFFFF if dark else 0x000000)):
        dwm(wintypes.HWND(window), attribute, ctypes.byref(ctypes.c_int(value)), 4)


def load_state() -> dict:
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state), encoding="utf-8")
    except OSError:
        pass


class Bridge:
    """What the page can ask of the window, as window.pywebview.api (the window sets _window)."""

    def __init__(self, color: str):
        self._window = 0
        self._color = color

    def title_color(self, color):
        if isinstance(color, str) and COLOR.fullmatch(color):
            self._color = color
            if self._window:
                paint_title_bar(self._window, color)


def on_context_menu(sender, args):
    """Right-click menus only where there's text to cut, copy or paste: the player has its own elsewhere."""
    target = args.ContextMenuTarget
    if not (target.IsEditable or target.HasSelection):
        args.Handled = True


def on_webview_ready(sender, args):
    """Runs after pywebview has set the web view up, to change what Folder Player needs different."""
    if not args.IsSuccess:
        return
    sender.CoreWebView2.Settings.AreDefaultContextMenusEnabled = True
    sender.CoreWebView2.ContextMenuRequested += on_context_menu


def open_window(webview) -> None:
    """Show the player in its window; returns once the window is closed."""
    state = load_state()
    color = state.get("color") if COLOR.fullmatch(str(state.get("color"))) else DEFAULT_COLOR
    bridge = Bridge(color)
    window = webview.create_window(NAME, URL, js_api=bridge, width=WINDOW_SIZE[0], height=WINDOW_SIZE[1],
                                   min_size=(360, 480), background_color=color)

    def before_show():  # on the window's own thread, before it appears
        import System.Windows.Forms as WinForms
        from Microsoft.Win32 import SystemEvents
        from System.Drawing import Rectangle

        form = window.native
        handle = int(form.Handle.ToInt64())
        bridge._window = handle
        tag_window(handle)
        bounds = state.get("bounds")
        if isinstance(bounds, list) and len(bounds) == 4 and all(isinstance(v, int) for v in bounds) \
                and on_screen(bounds):
            form.StartPosition = WinForms.FormStartPosition.Manual
            form.Bounds = Rectangle(*bounds)
        if state.get("maximized") is True:
            form.WindowState = WinForms.FormWindowState.Maximized
        paint_title_bar(handle, bridge._color)
        # pywebview sets the title bar to light or dark when Windows switches; put the theme back on.
        SystemEvents.UserPreferenceChanged += lambda *_: paint_title_bar(handle, bridge._color)
        form.webview.CoreWebView2InitializationCompleted += on_webview_ready

    def closing():  # on the window's own thread
        import System.Windows.Forms as WinForms

        form = window.native
        normal = form.WindowState == WinForms.FormWindowState.Normal
        bounds = form.Bounds if normal else form.RestoreBounds
        save_state({"bounds": [bounds.X, bounds.Y, bounds.Width, bounds.Height],
                    "maximized": form.WindowState == WinForms.FormWindowState.Maximized,
                    "color": bridge._color})

    window.events.before_show += before_show
    window.events.loaded += lambda: window.evaluate_js(FOLLOW_THEME)
    window.events.closing += closing
    webview.settings["ALLOW_DOWNLOADS"] = True  # Export asks where to save the playlist file
    webview.start(private_mode=False, storage_path=str(STORAGE), icon=str(ICON))


def run() -> None:
    try:
        server = Server((HOST, PORT), Handler)
    except OSError:
        if not player_answering():
            message(f"Another program is using port {PORT}, which Folder Player needs. "
                    "Close that program and try again.", error=True)
            return
        if focus_window():  # already running: show it
            return
        server = None  # being served, but with no window yet (it may still be opening): open one
    try:
        try:  # loaded only now: it takes a few seconds, which showing an open window shouldn't
            import webview
            from webview.platforms import winforms
        except ImportError:
            if getattr(sys, "frozen", False):  # inside an AudioGrabber.exe built without it
                message("This AudioGrabber.exe was built without pywebview, which Folder Player needs to "
                        "draw its window. Build Audio Grabber again with pywebview installed, or start "
                        "Folder Player from its own shortcut.", error=True)
            else:
                message("Folder Player needs the Python package pywebview to draw its window. Install it "
                        "with:\n\npython -m pip install pywebview", error=True)
            return
        if not winforms.is_chromium:
            message("Folder Player's window needs the Microsoft Edge WebView2 Runtime, which comes with "
                    "Windows 11 but isn't on this PC. Microsoft has it for download: search for "
                    "\"WebView2 Runtime\".", error=True)
            return
        if server is not None:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
        open_window(webview)
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()


def main() -> None:
    if sys.platform != "win32":
        raise SystemExit("The Folder Player app is for Windows. Elsewhere, serve this folder "
                         "(python -m http.server 8417) and open http://127.0.0.1:8417/")
    if "--shortcut" in sys.argv[1:]:
        make_shortcuts()
        return
    try:
        run()
    except Exception as e:  # usually started without a console: show what went wrong instead of vanishing
        traceback.print_exc()
        message(f"Folder Player couldn't start:\n{e}", error=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
