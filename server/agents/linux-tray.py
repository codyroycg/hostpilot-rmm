#!/usr/bin/env python3
"""HostPilot tray icon for Linux desktops (the Linux counterpart of HostPilotTray.exe).

Runs in each graphical user session (started by /etc/xdg/autostart/hostpilot-tray.desktop) and shows whether
the HostPilot agent (running as root) is connected, lets the user ask it to update now, and provides a chat
window with the IT team.

The agent publishes its state in /var/lib/hostpilot-tray/status.json (readable by every user):
  state, heartbeat (unix ms of the agent's last loop), last_contact, server, version, message, chat_token
"Update now" creates /var/lib/hostpilot-tray/requests/update-now, which the agent picks up within ~30 s.
The chat token only grants access to this device's conversation.

Needs python3 with PyGObject (GTK 3). Uses AyatanaAppIndicator3 / AppIndicator3 when available (GNOME with
the AppIndicator extension, KDE, Ubuntu, Mint, ...), otherwise the classic Gtk.StatusIcon (Xfce, MATE, LXDE).
"""
import fcntl
import json
import math
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

import gi
gi.require_version('Gtk', '3.0')
from gi.repository import GLib, Gtk, Gdk, Pango  # noqa: E402

Indicator = None
for _name in ('AyatanaAppIndicator3', 'AppIndicator3'):
    try:
        gi.require_version(_name, '0.1')
        Indicator = __import__('gi.repository.' + _name, fromlist=[_name])
        break
    except (ValueError, ImportError):
        pass

STATE_DIR = '/var/lib/hostpilot-tray'
STATUS_FILE = os.path.join(STATE_DIR, 'status.json')
UPDATE_REQUEST = os.path.join(STATE_DIR, 'requests', 'update-now')
CACHE = os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache'), 'hostpilot-tray')
COLORS = {'connected': (0.13, 0.77, 0.37), 'disconnected': (0.94, 0.27, 0.27), 'stopped': (0.58, 0.64, 0.72), 'updating': (0.22, 0.74, 0.97)}
LABELS = {'connected': 'Connected', 'disconnected': "Disconnected - can't reach the server", 'stopped': 'Agent not running', 'updating': 'Updating...'}


def read_status():
    try:
        with open(STATUS_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def ago(ms):
    if not ms:
        return 'never'
    s = max(0, time.time() - ms / 1000)
    if s < 60:
        return '%ds ago' % s
    if s < 3600:
        return '%d min ago' % (s / 60)
    if s < 172800:
        return '%d h ago' % (s / 3600)
    return time.strftime('%Y-%m-%d %H:%M', time.localtime(ms / 1000))


def make_icons():
    """Blue rounded square with a white "H" and a status dot, one PNG per state (cairo ships with PyGObject)."""
    import cairo
    os.makedirs(CACHE, exist_ok=True)
    paths = {}
    for state, (r, g, b) in COLORS.items():
        path = os.path.join(CACHE, 'hostpilot-%s.png' % state)
        surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, 64, 64)
        cr = cairo.Context(surf)
        x, y, w, h, rad = 2, 2, 54, 54, 13
        cr.new_sub_path()
        cr.arc(x + w - rad, y + rad, rad, -math.pi / 2, 0)
        cr.arc(x + w - rad, y + h - rad, rad, 0, math.pi / 2)
        cr.arc(x + rad, y + h - rad, rad, math.pi / 2, math.pi)
        cr.arc(x + rad, y + rad, rad, math.pi, 3 * math.pi / 2)
        cr.close_path()
        cr.set_source_rgb(0.15, 0.39, 0.92)
        cr.fill()
        cr.set_source_rgb(1, 1, 1)
        cr.select_font_face('Sans', cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(34)
        ext = cr.text_extents('H')
        cr.move_to(x + (w - ext.width) / 2 - ext.x_bearing, y + (h - ext.height) / 2 - ext.y_bearing)
        cr.show_text('H')
        cr.arc(48, 48, 13, 0, 2 * math.pi)
        cr.set_source_rgb(1, 1, 1)
        cr.fill()
        cr.arc(48, 48, 10, 0, 2 * math.pi)
        cr.set_source_rgb(r, g, b)
        cr.fill()
        surf.write_to_png(path)
        paths[state] = path
    return paths


def notify(title, body):
    try:
        subprocess.Popen(['notify-send', '-a', 'HostPilot', '-i', ICONS.get('connected', ''), title, body],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


class ChatWindow(Gtk.Window):
    def __init__(self, app):
        super().__init__(title='IT support chat')
        self.app = app
        self.set_default_size(420, 520)
        self.set_icon_from_file(ICONS['connected'])
        self.connect('delete-event', lambda *a: self.hide() or True)  # closing hides; the chat keeps running
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        head = Gtk.Label(label='  Chat with your IT support team', xalign=0)
        head.get_style_context().add_class('title')
        css = Gtk.CssProvider()
        css.load_from_data(b'.hp-head { background: #2563eb; color: white; font-weight: bold; padding: 8px; }')
        head.get_style_context().add_provider(css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        head.get_style_context().add_class('hp-head')
        box.pack_start(head, False, False, 0)
        self.view = Gtk.TextView(editable=False, cursor_visible=False, wrap_mode=Gtk.WrapMode.WORD_CHAR, left_margin=10, right_margin=10, top_margin=8)
        buf = self.view.get_buffer()
        buf.create_tag('tech', weight=Pango.Weight.BOLD, foreground='#2563eb')
        buf.create_tag('me', weight=Pango.Weight.BOLD, foreground='#166534')
        buf.create_tag('time', foreground='#888888', scale=0.85)
        buf.create_tag('muted', foreground='#888888')
        sw = Gtk.ScrolledWindow(vexpand=True)
        sw.add(self.view)
        self.scroll = sw
        box.pack_start(sw, True, True, 0)
        bottom = Gtk.Box(spacing=6, margin=8)
        self.input = Gtk.TextView(wrap_mode=Gtk.WrapMode.WORD_CHAR)
        isw = Gtk.ScrolledWindow(min_content_height=56)
        isw.add(self.input)
        self.input.connect('key-press-event', self.on_key)
        self.send_btn = Gtk.Button(label='Send')
        self.send_btn.connect('clicked', lambda *a: self.send())
        bottom.pack_start(isw, True, True, 0)
        bottom.pack_start(self.send_btn, False, False, 0)
        box.pack_start(bottom, False, False, 0)
        self.status = Gtk.Label(label='Enter to send, Shift+Enter for a new line', xalign=0, margin_start=10, margin_bottom=6)
        self.status.get_style_context().add_class('dim-label')
        box.pack_start(self.status, False, False, 0)
        self.add(box)

    def on_key(self, widget, ev):
        if ev.keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter) and not (ev.state & Gdk.ModifierType.SHIFT_MASK):
            self.send()
            return True
        return False

    def set_history(self, msgs):
        buf = self.view.get_buffer()
        buf.set_text('')
        if not msgs:
            buf.insert_with_tags_by_name(buf.get_end_iter(), 'No messages yet. Type below to contact your IT team.\n', 'muted')
        for m in msgs:
            tech = m.get('direction') == 'tech'
            who = 'IT support (%s)' % m.get('author', '') if tech else 'You'
            buf.insert_with_tags_by_name(buf.get_end_iter(), who + '  ', 'tech' if tech else 'me')
            buf.insert_with_tags_by_name(buf.get_end_iter(), time.strftime('%H:%M', time.localtime(m.get('created_at', 0) / 1000)) + '\n', 'time')
            buf.insert(buf.get_end_iter(), m.get('body', '') + '\n\n')
        GLib.idle_add(lambda: self.view.scroll_to_iter(buf.get_end_iter(), 0, False, 0, 1) and False)

    def send(self):
        ib = self.input.get_buffer()
        text = ib.get_text(ib.get_start_iter(), ib.get_end_iter(), False).strip()
        if not text:
            return
        self.send_btn.set_sensitive(False)
        self.status.set_text('Sending...')

        def work():
            err = self.app.chat_send(text)

            def done():
                self.send_btn.set_sensitive(True)
                if err:
                    self.status.set_text("Couldn't send: %s" % err)
                else:
                    ib.set_text('')
                    self.status.set_text('Sent')
                return False
            GLib.idle_add(done)
        threading.Thread(target=work, daemon=True).start()


class TrayApp:
    def __init__(self):
        self.state = None
        self.update_requested = 0
        self.version_at_request = None
        self.history = []
        self.last_id = 0
        self.loaded = False
        self.chat = None
        self.menu = Gtk.Menu()
        self.items = {}
        for key in ('status', 'server', 'contact', 'version'):
            it = Gtk.MenuItem(label='')
            it.set_sensitive(False)
            self.menu.append(it)
            self.items[key] = it
        self.menu.append(Gtk.SeparatorMenuItem())
        chat_item = Gtk.MenuItem(label='Chat with IT support...')
        chat_item.connect('activate', lambda *a: self.show_chat())
        self.menu.append(chat_item)
        upd = Gtk.MenuItem(label='Update agent now')
        upd.connect('activate', lambda *a: self.update_now())
        self.menu.append(upd)
        self.menu.show_all()

        if Indicator:
            self.ind = Indicator.Indicator.new('hostpilot-agent', ICONS['stopped'], Indicator.IndicatorCategory.SYSTEM_SERVICES)
            self.ind.set_status(Indicator.IndicatorStatus.ACTIVE)
            self.ind.set_menu(self.menu)
            self.ind.set_title('HostPilot')
            self.icon = None
        else:
            self.ind = None
            self.icon = Gtk.StatusIcon()
            self.icon.set_from_file(ICONS['stopped'])
            self.icon.connect('popup-menu', lambda icon, button, t: self.menu.popup(None, None, Gtk.StatusIcon.position_menu, icon, button, t))
            self.icon.connect('activate', lambda *a: self.show_chat())
        self.refresh()
        GLib.timeout_add_seconds(5, self.refresh)
        threading.Thread(target=self.chat_loop, daemon=True).start()

    # ---------- status ----------
    def current(self, st):
        hb = st.get('heartbeat') or 0
        alive = hb and time.time() - hb / 1000 < 120
        if self.update_requested:
            if time.time() - self.update_requested > 120 or (self.version_at_request and st.get('version') != self.version_at_request):
                self.update_requested = 0
            else:
                return 'updating'
        if not alive:
            return 'stopped'
        return 'connected' if st.get('state') == 'connected' else 'disconnected'

    def refresh(self):
        st = read_status()
        s = self.current(st)
        server = st.get('server', '')
        host = urllib.parse.urlparse(server).hostname or server or 'unknown'
        self.items['status'].set_label('Status: ' + LABELS[s])
        self.items['server'].set_label('Server: ' + host)
        self.items['contact'].set_label('Last contact: ' + ago(st.get('last_contact')))
        self.items['version'].set_label('Agent version: ' + (st.get('version') or 'unknown'))
        if s != self.state:
            if self.state == 'updating' and s == 'connected':
                notify('HostPilot', 'The agent was updated and is connected.')
            self.state = s
            if self.ind:
                self.ind.set_icon_full(ICONS[s], 'HostPilot: ' + LABELS[s])
            else:
                self.icon.set_from_file(ICONS[s])
        if self.icon:
            self.icon.set_tooltip_text('HostPilot: ' + LABELS[s])
        return True

    def update_now(self):
        try:
            with open(UPDATE_REQUEST, 'w') as f:
                f.write(str(int(time.time())))
        except OSError as e:
            notify('HostPilot', "The update request couldn't be sent: %s" % e)
            return
        self.version_at_request = read_status().get('version')
        self.update_requested = time.time()
        self.refresh()
        notify('HostPilot', 'Update requested. The agent will download the latest version and restart within about 30 seconds.')

    # ---------- chat ----------
    def chat_url(self, path, **q):
        st = read_status()
        server, token = (st.get('server') or '').rstrip('/'), st.get('chat_token') or ''
        if not server or not token:
            return None
        q['token'] = token
        return '%s%s?%s' % (server, path, urllib.parse.urlencode(q))

    def chat_loop(self):
        while True:
            url = self.chat_url('/api/chat/device/poll', after=self.last_id, wait=25 if self.loaded else 0)
            if not url:
                time.sleep(10)
                continue
            try:
                with urllib.request.urlopen(url, timeout=40) as r:
                    data = json.loads(r.read().decode('utf-8'))
                incoming = False
                new = False
                for m in data.get('messages') or []:
                    if m['id'] <= self.last_id:
                        continue
                    self.last_id = m['id']
                    self.history.append(m)
                    new = True
                    if m.get('direction') == 'tech' and (self.loaded or not m.get('read_at')):
                        incoming = True
                self.loaded = True
                if new:
                    GLib.idle_add(self.on_messages, incoming)
            except Exception:  # network errors, server restarts: retry
                time.sleep(8)

    def on_messages(self, incoming):
        if self.chat:
            self.chat.set_history(self.history)
        if incoming:
            self.show_chat(alert=True)
        return False

    def show_chat(self, alert=False):
        if not self.chat:
            self.chat = ChatWindow(self)
            self.chat.set_history(self.history)
        self.chat.show_all()
        if alert:
            self.chat.set_urgency_hint(True)
            self.chat.present()
            notify('Message from IT support', 'Your IT team sent you a message.')
        else:
            self.chat.present()

    def chat_send(self, text):
        url = self.chat_url('/api/chat/device/send')
        if not url:
            return 'not connected to the HostPilot server'
        body = json.dumps({'author': os.environ.get('USER') or 'User', 'body': text}).encode('utf-8')
        try:
            req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'}, method='POST')
            urllib.request.urlopen(req, timeout=15).close()
            return None
        except Exception as e:
            return str(e)


def main():
    # hostpilot-tray.py --update   -> ask the agent to update now (works for any user, also while the icon runs)
    if '--update' in sys.argv:
        try:
            open(UPDATE_REQUEST, 'w').close()
        except OSError as e:
            print("The HostPilot agent isn't installed or running: %s" % e)
            return 1
        print('Update requested. The agent will update within about 30 seconds.')
        return 0
    # one icon per user session
    run_dir = os.environ.get('XDG_RUNTIME_DIR') or '/tmp'
    lock = open(os.path.join(run_dir, 'hostpilot-tray-%d.lock' % os.getuid()), 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return 0
    global ICONS
    ICONS = make_icons()
    TrayApp()
    Gtk.main()
    return 0


ICONS = {}
if __name__ == '__main__':
    sys.exit(main())
