#!/usr/bin/env python3
"""HostPilot tray icon for Linux desktops (the Linux counterpart of HostPilotTray.exe).

Runs in each graphical user session (started by /etc/xdg/autostart/hostpilot-tray.desktop) and shows whether
the HostPilot agent (running as root) is connected, lets the user ask it to update now, and provides a chat
window with the IT team, and lets the user open support tickets for this computer and follow them.

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
import urllib.error
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


# Blue rounded square with a white "H" and a status dot, one 64x64 PNG per state. Embedded so the icon
# doesn't need the cairo Python module (python3-gi-cairo), which isn't installed everywhere.
ICON_PNG = {
    'connected': 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAARXSURBVHhe7VtNSBRRHPfYsaM3JXf7gKCgQ9AhvAgdukSXiGjXmQ5LIIgURkhYEEIYRh0kBA0q6mBGeDCMkKLQyI/oQyMVSaltd1Zdv9LVfC/+2+zum/97O+7O248Zmx/8LrvvvXm/38z83/89/lNS4sJFVijzTe2oULVKoFcJ+b2q1lgwKiF/4towDzy3vAIu7lEjT72qtupVNWoHwnw8yq8AnmtOAW57FG0EX9xO9KjhsQo1dAzPXRqe6nAtvpjN2YI1WIZH1ToEF7A/Fa1HOj54qkOXuIEdRI+qPcKaMga8S3hAJ9JycLR7wMuCwTLf/E6szxTgmmAg5/JcpAlrNIVXCfdxgziYsDxijWkBj4udkpxccbdP24u1ChFPbQUDOJ5KyI+1CuFVwqe4ztuAsKRjrUI4MOvLlI1YqxD6jgt33g50DcBahZA14EjdLD1xbd7AqstzXDvMA+cjXD8gbifBwhjQ+GCJYvQOxbh2mCBWBNxOgq4BWKsQrgGuAa4BrgGCzhnTNcA1gDdg8Ns6l+BgXmhbxN3iwONLsHgGyACPL0HXAKxVCNeAPBkAgdCMECdEwONLsHgG/PergGuAa0B+DNgfiNAzN6Ic4XfcdlsZUN++RF8Mx+jaOsHNk4D/r9xfYvs53wC4u6PTG7iJKSaDf6jasgD9nW3A9cfL+K84Jn7/pAPRsSS/LH/HTeJ49SnWj7UKYUcDnrxZxT/T9h/PadVwPd319izHo4N19NZ0F13bNOYWhJAeSql50YTdDGjuNN55uOMnP17lRIsIBg0vThj6E0LMiyZkDQjcWeCyvJtdK1w7TDg6x/2Gxo3ve2foNd3Xr3JCt2LrTLdhHEJI+qIJWQNySTbgwZ23Ij5BiA+MAUFKqbhowi51QbCEscj0sU/Hw+9r6MLGCmuCuGhCr/rkJlRoDnxNBTAIeFiQFV4cb2MNEBdN2KE+4FBNxJDkQFTHYqwQXiH2KaCU8kUTe3zBcjyhQhMSngRgXcdCZNg7O8gaIC6aKHaFWO3d1Plgt9bPiZAhWhHERRPFXgnYAPgw+JITIUNIkBiI02O9UCqIJ1YowmYnAVj7sQgZZmQAoJilMmwMgEwOi5AhvFIMxDEgAf27AG6C+WZl/VxyhpDPH3wX4IRY5cyaxhpQiTUbANXWxQqIbBbYMHmPE2KFxz80JMeEbBDrFSIeD4pQOXr7WWq9Dsei8UwOC8qGkAOwW2VCSAfWagqoty1kBSkkQ+HoZnLCsH5jUdmQXf4IIbC/5pOgrVDmC5X++4AiPI8nnA/iQxCrr4J/tNkwDiFE/osSPWWGfCGvHJ3eSG3j9GUx06AIj71gKzyy5aGInQCT1SedBMSE05+bOMEs0xyGTFFKy/E1bA/YuxNC+gxqKI0vaZApQnKTIOwc4ewAQzfReeJZwB5eD2BZgRDS6qjH3gyU0lJYwggh4kNEHfA/nP9ZivZOAWRykM9jEkJy//Gki22Ov0pfnovk9v+LAAAAAElFTkSuQmCC',
    'disconnected': 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAARSSURBVHhe7VtPSBRRGPfYsaM3BXerQ9ChWycPBuHJLtJBWHcnUAJBMjA7hAQRZKHUISJIpMAOWYQHqUAJhDpkCsEaZQh72T+z/l1tXf98L75pdn3zvee4O8/dnbH5we+y+96b9/vNzPe+9/impsaHj5JQF1o80aDpjchgJNke1PT+ijGSbM9fG+dB51ZW4MUDWvptUNOzQU1nbiDOJxBJdNK5HinQ7UBEn6UXdxMDWmq+QUteonNXRiCc6qYXczkHqQbHCGj6sOQC7mdEn1COD4Fw8qYwsIcY0PRRqqlo4LtEB/QiHQdHtwe8EhivC62cpPpsga5JBvIur6bvUY22CEZSU8IgHiYuj1TjgcDHxU1JzlHxVEg/Q7VKYaS2kgE8z0iynWqVIhhJXRE6HwPikk61SuHBrK9Y9lOtUpg7Ltr5ONA3gGqVQtWAC9eX2OU7KxZevLUstKM8dy0t9EPSdgqsjAH9LzOM4sNMTmhHiWJloO0U6BtAtUrhG+Ab4BvgGyDpXDR9A3wDRAO+/twWEhzKG8/WaTcDdHwFVs8AFdDxFegbQLVK4RtQJgMwENoR44QMdHwFVs+A/34V8A3wDSiPAWc706zt/qpA/J22PVYG9D7PsI/fcmxrG2jzAvD/2y8yfD/vG4B3NxrboU1s8Tu+y7TBNezvbQPuvtqgfxnYjcXYztxcgbsLC7SJgU/fc5+pVincaMDYdJb+zLbGxth6OMxWmpoErrW1sezICINcztIHACYYY/ZFE24z4MFr653HO57p6hJEy4gG7USjlv4AYF80oWpA5+M1Ict7+GZTaEeJR+e038wv6/uee/+erTY3C0IPY3Z01DIOABxcNKFqwFGSD3h4552IzxPjA2dAnDEmL5pwS10QLmE8in3sD+JaayuDzP6YACAvmjCrPoUJVZpffuxvjjDgUUFOuDkwwBsgL5pwQ33A+a60JcnBqE7FOCG+QvxTwBgTiyZOh+L1dEKVJiY8eeC6ToWocHt6mjdAXjRR7Qqx7qf754O5yUlBhArJiiAvmqj2SsAHwK3xcUGECjFB4iBPj81CqTidWKWIm508cO2nIlRYlAGIapbK8DEAMzkqQoX4SnGQx4A8zO8ChAmWm429y4UZYj6/2tIiCHHKvUSCN6CRarYAq62rFRD5LPDP0JAgxAnXOzoKY2I2SPVKYcSDKlSOPnq3WZjs3tKSkclRQaUQcwB+qwwAw1SrLbDetpIVpJgMpVb3ChPG9ZuKKoX88gcAuL8Wk6DDUBdK1v77gCK1QidcDtJDEKevwkZfn2UcAFD/osRMmTFfKCujsZ15fvLGlrjIoIiPvWQrPHvooYibgJM1J10AxoRMT48gmOcBhyGLjLF6eg3XA/fuADBlUYNGJBJGpojJTZ64c8SzAwrTRO+J54F7eDOAlQQAeOKpx94OjLFaXMIAQH6IaAL/x/M/R9HeK8BMDvN5SgA4+o8nfRxz/AWt7NsCLa2fJwAAAABJRU5ErkJggg==',
    'stopped': 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAARQSURBVHhe7VtNaBNBFO7Ro8feWmiiHgQP3jz1Inj15kFIm/VQBKGIUPEgRRBBlIIKRQotWH8qVItFqFRKLUptpbVKsNXWUinFNNn0N/1LW9/Ii5tk9s0kTXbysxv3g++SzMzO9+3umzfD24oKFy5yQpVv7lCNptcivf5QnVfTm4tGf6gucW2cB51bQYEX92iRHq+mb3s1ndmBOB+Pf7GBzjWvQLc9fn2CXtxO9GjhqRotdIbOXRme+nAjvZjN2UI1WIZH0zskF7A//Xqfcnzw1IeuCgM7iB5Nf0Y1ZQ18l+iATqTl4Gj3gJcDg1W+lcNUX0aga5KBnMsLkVtUY0Z4/eFBYRAHE5dHqjEt8HGxU5KTLx7x6ceoViniqa1kAMfTH6qjWqXw+sPnhM5lQFzSqVYpHJj1ZctmqlUKY8dFO5cDXQOoVilUDTh1eYmdvbFi4ulry0I7yhMXI0I/JG2nwOIY0Pw4yij6x2NCO0oUKwNtp0DXAKpVCtcA1wDXANcASees6RrgGiAaMDa9KyQ4lFfa1mm3OOj4CiydASqg4yvQNYBqlcI1oEAGYCDMRIwTMtDxFVg6A/77VcA1wDWgMAYcb4iw87dXBeLvtG1ZGdDUHmVvP8fYzi7Q5kng/9c7o3w/5xuAd3dyfo82yYjZ4D7TWtawv7MNuNm1Qf+KY3l1gy0sLiWpL8tT6qFA7CPVKoUdDXjxYZv+zL5M/mJPet+zB51vBD7qGWKjX2fY/v4fUx8A6GOMZS6asJsBd7rNdx7veHffiCBaRjQoqJvHBYDMRROqBjTcXxOyvLsvN4V2lHh0TvuNz5jf96mfC6z1ab8g9CCOBWZN4wBA+qIJVQPyST7g4Z23Ij5BjA+cAUHGmLxowi51QbiE8cj2sU/H9u5BthNLGQoA8qIJo+pTmFCxOfI9tTnCgEcFWeHAcIA3QF40YYf6gJOXIqYkB6M6FWOF+ArxTwFjTCyaOOoLVtMJFZuY8CSA6zoVosLZ+RBvgLxootQVYo0PU8nM9NxvQYQKyYogL5oo9UrAB8DAj3lBhAoxQeIgT4+NQqkgnVixiJudBHDtpyJUmJUBiFKWyvAxADM5KkKF+EpxkMeABIzvAoQJFpq1TcvJGWI+3/Z8QBBilevRLd6AWqrZBKy2LlVA5LPAd6PfBCFW2PV6ODkmZoNUrxTxeFCCytF7rzaTk93c2olnclRQLsQcgN8qA0AH1ZoRWG9bzApSTIbCq6ntLK7fVFQu5Jc/AMD9tZgEHYQqX6jy3wcU4RU64UKQHoJYfRV6B8ZM4wCA+hclRsqM+UJBOTm/N8VPHpfFbIMiPvaSrfDEgYcidgJO1ph0EhgTevo/CYJ5pjkMmWOMVdNr2B64dweAQZMaxuJLGmaKmNwkiDtHPDugMEx0nngeuIc3AlhOAIBWRz32mcAYq8QlDADkh4gG8H88/7MU7Z0CzOQwn6cEgPx/POmizPEX/0NsCyeqzmUAAAAASUVORK5CYII=',
    'updating': 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAARGSURBVHhe7VtPSBRhFPfYsaM3BWerQ9ChS3QIL0LQyVMdotUdDyIEEoHRIaSIKAqhDhFCEgV5KCMIBCNEKozwTyCoGKVIuO7O5r9NdFx9L942uzvzvm/H3Zn9M2Pzg9/F/b5v3vvNzHvv+3xTUxMgQFGoC88falC1RmIoEmsJqVp3xRiJtWSuTXZw28oKuriiJt6EVG0rpGroBZI9SmS5ndtaUpDaSkSb5Bf3EhU1PtOgxs5y211DaY138ot5nD3cB8dQVK1PcgHvM6INuo4PSmvsmrCwj6io2kvuU8Ggd4kv6Ec6Do5eD3hFMFoXXj3M/bMFqSZZyL9sS9zhPtoiFIkPC4v4mJQeuY95QY+Ll4qcUvFIWDvGfZUiXdpKFvA9I7EW7qsUoUj8gjD5AJBSOvdVCh9WfYWym/sqhbHj4pMPAgMBuK9SuBXg9JXf2Hxz1cKm6yvCOM4THQlhHpGPc8HKCND9IokcQ+O6MI6TnJWBj3PBQADuqxSBAIEAgQCBAJLJBTMQIBBAFGBsbkcocDiv9m7waWnw9V2wegK4AV/fBQMBuK9SBAKUSQAKhHakOCEDX98FqyfAf58FAgECAcojwPH2BF68tyaQ/s7HHigBup4m8f2Ejts7wIdnQb/feJ40z/O/AHR3pxdTfIgtfkR3Ue1Zp/n+FuB2/x/+UxoLm4DjK3tZzm3In4qRKX2U+yqFFwV4/WmL/xn7F3fx/KiOpz5sC2z+rGPvzxTqe9Y5ADCIiPZNE14T4P4r652nO942tiM4LSMJNLVmVQEA7Jsm3ArQ/mhdqPIeDGwK4zjp6JzPG/9ufd/fLe3imWHR0f34bMG6DgDkb5pwK0ApaQ54dOedOJ8hxQeTAFFElDdNeKUviFKYGYU+9vl47qOOSdODAADypgmj61MwqNL8MpvbHFHA4w454a3pnAIAIG+a8EJ/wMnLCUuRQ1GdO+OE9AqZnwJEFJsmjoaj9dygSpMKngwor3NH3HAkbskK8qaJaneIdT7JnQ8OLZfm8c+QZQR500S1M4E5AA78Kq0AVCCZIC+PjUapKDesUqTNTgaU+7kTbliQAIRqtsqYYwBVctwJN6RXygR5DMjA+C5AMLDcbOxayVpI9XzTSGmyAHFpy7JZauQ+W0Dd1tUKiOYq8O5sSnDECS99zdUWVA1yf6VIx4MqdI4+fLuZNTahQ7qS4w4VQ6oBzFtlAOjjvtqC+m0r2UFKxVDctJOj/M2dKobm9AcAtL8Wi6D9UBeO1f77gCK+yg0uB/khiNNXofOb9X8OAOD+ixKjZKZ6oaycXkzNmI2ntFhoUKTHXrIVntz3UMRLIGMNo7OgmNAxYb87zHMYMo+I9fwangft3QFg2OINYjqlUaVIxU2GtHOkswMOQ0T/OW8G7eGNAFYUAOCxrx57OyBiLaUwAJAfIhqg3+n8z1G09wuokqN6nhMASv/xZIADjr+77GmlUHC6sAAAAABJRU5ErkJggg==',
}


def make_icons():
    import base64
    os.makedirs(CACHE, exist_ok=True)
    paths = {}
    for state, data in ICON_PNG.items():
        path = os.path.join(CACHE, 'hostpilot-%s.png' % state)
        raw = base64.b64decode(data)
        try:
            with open(path, 'rb') as f:
                same = f.read() == raw
        except OSError:
            same = False
        if not same:
            with open(path, 'wb') as f:
                f.write(raw)
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


def http_error(e):
    """The server's own error text ("Describe the problem") instead of "HTTP Error 400"."""
    try:
        return json.loads(e.read().decode('utf-8')).get('error') or str(e)
    except Exception:
        return str(e)


def head_label(text):
    head = Gtk.Label(label='  ' + text, xalign=0)
    css = Gtk.CssProvider()
    css.load_from_data(b'.hp-head { background: #2563eb; color: white; font-weight: bold; padding: 8px; }')
    head.get_style_context().add_provider(css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    head.get_style_context().add_class('hp-head')
    return head


class NewTicketWindow(Gtk.Window):
    """Open a support ticket for this computer."""
    def __init__(self, app):
        super().__init__(title='Open a support ticket')
        self.app = app
        self.set_default_size(480, 440)
        self.set_icon_from_file(ICONS['connected'])
        self.connect('delete-event', lambda *a: self.hide() or True)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        box.pack_start(head_label('Ask your IT support team for help'), False, False, 0)
        inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin=12)
        inner.pack_start(Gtk.Label(label='What do you need help with?', xalign=0), False, False, 0)
        self.subject = Gtk.Entry(max_length=200)
        inner.pack_start(self.subject, False, False, 0)
        inner.pack_start(Gtk.Label(label='Describe the problem (what happens, since when, any error message):', xalign=0, margin_top=6), False, False, 0)
        self.body = Gtk.TextView(wrap_mode=Gtk.WrapMode.WORD_CHAR)
        sw = Gtk.ScrolledWindow(vexpand=True, shadow_type=Gtk.ShadowType.IN)
        sw.add(self.body)
        inner.pack_start(sw, True, True, 0)
        self.urgent = Gtk.CheckButton(label="It's urgent: I can't work")
        inner.pack_start(self.urgent, False, False, 0)
        row = Gtk.Box(spacing=6)
        self.status = Gtk.Label(label='', xalign=0)
        row.pack_start(self.status, True, True, 0)
        cancel = Gtk.Button(label='Cancel')
        cancel.connect('clicked', lambda *a: self.hide())
        self.send_btn = Gtk.Button(label='Send ticket')
        self.send_btn.connect('clicked', lambda *a: self.send())
        row.pack_start(cancel, False, False, 0)
        row.pack_start(self.send_btn, False, False, 0)
        inner.pack_start(row, False, False, 0)
        box.pack_start(inner, True, True, 0)
        self.add(box)

    def send(self):
        subject = self.subject.get_text().strip()
        b = self.body.get_buffer()
        body = b.get_text(b.get_start_iter(), b.get_end_iter(), False).strip()
        if not subject:
            self.status.set_text('Write a short subject.')
            return
        if not body:
            self.status.set_text('Describe the problem.')
            return
        urgent = self.urgent.get_active()
        self.send_btn.set_sensitive(False)
        self.status.set_text('Sending...')

        def work():
            res, err = self.app.ticket_call('POST', '/api/chat/device/ticket', {'subject': subject, 'body': body, 'urgent': urgent})

            def done():
                self.send_btn.set_sensitive(True)
                if err:
                    self.status.set_text("Couldn't send: %s" % err)
                    return False
                self.subject.set_text('')
                b.set_text('')
                self.urgent.set_active(False)
                self.status.set_text('')
                self.hide()
                self.app.ticket_seen[res['id']] = 0
                notify('Ticket #%s sent' % res['id'], "Your IT team has your request. You'll get a notification when they reply.")
                return False
            GLib.idle_add(done)
        threading.Thread(target=work, daemon=True).start()


class TicketsWindow(Gtk.Window):
    """This computer's support tickets: read the conversation and reply."""
    def __init__(self, app):
        super().__init__(title='My support tickets')
        self.app = app
        self.tickets = []
        self.set_default_size(560, 600)
        self.set_icon_from_file(ICONS['connected'])
        self.connect('delete-event', lambda *a: self.hide() or True)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        top = Gtk.Box()
        top.pack_start(head_label('Support tickets from this computer'), True, True, 0)
        new_btn = Gtk.Button(label='New ticket...')
        new_btn.connect('clicked', lambda *a: self.app.show_new_ticket())
        top.pack_start(new_btn, False, False, 4)
        box.pack_start(top, False, False, 0)
        self.store = Gtk.ListStore(int, str)
        self.list = Gtk.TreeView(model=self.store, headers_visible=False)
        self.list.append_column(Gtk.TreeViewColumn('Ticket', Gtk.CellRendererText(), text=1))
        self.list.get_selection().connect('changed', lambda *a: self.show_selected())
        lsw = Gtk.ScrolledWindow(min_content_height=130)
        lsw.add(self.list)
        box.pack_start(lsw, False, False, 0)
        self.view = Gtk.TextView(editable=False, cursor_visible=False, wrap_mode=Gtk.WrapMode.WORD_CHAR, left_margin=10, right_margin=10, top_margin=8)
        buf = self.view.get_buffer()
        buf.create_tag('title', weight=Pango.Weight.BOLD, scale=1.15)
        buf.create_tag('tech', weight=Pango.Weight.BOLD, foreground='#2563eb')
        buf.create_tag('me', weight=Pango.Weight.BOLD, foreground='#166534')
        buf.create_tag('time', foreground='#888888', scale=0.85)
        sw = Gtk.ScrolledWindow(vexpand=True)
        sw.add(self.view)
        box.pack_start(sw, True, True, 0)
        bottom = Gtk.Box(spacing=6, margin=8)
        self.input = Gtk.TextView(wrap_mode=Gtk.WrapMode.WORD_CHAR)
        isw = Gtk.ScrolledWindow(min_content_height=56, shadow_type=Gtk.ShadowType.IN)
        isw.add(self.input)
        self.send_btn = Gtk.Button(label='Reply')
        self.send_btn.connect('clicked', lambda *a: self.reply())
        bottom.pack_start(isw, True, True, 0)
        bottom.pack_start(self.send_btn, False, False, 0)
        box.pack_start(bottom, False, False, 0)
        self.status = Gtk.Label(label='', xalign=0, margin_start=10, margin_bottom=6)
        self.status.get_style_context().add_class('dim-label')
        box.pack_start(self.status, False, False, 0)
        self.add(box)

    def selected(self):
        model, it = self.list.get_selection().get_selected()
        if not it:
            return None
        tid = model[it][0]
        return next((t for t in self.tickets if t['id'] == tid), None)

    def reload(self, select=0):
        cur = self.selected()
        keep = select or (cur['id'] if cur else 0)
        self.status.set_text('Loading...')

        def work():
            res, err = self.app.ticket_call('GET', '/api/chat/device/tickets')

            def done():
                if err:
                    self.status.set_text("Couldn't load tickets: %s" % err)
                    return False
                self.tickets = res
                self.store.clear()
                for t in res:
                    self.store.append([t['id'], '#%s   %s   [%s]' % (t['id'], t['subject'], t['status_text'])])
                self.status.set_text('No tickets yet. Click "New ticket..." to ask for help.' if not res else 'Write a reply below.')
                idx = next((i for i, t in enumerate(res) if t['id'] == keep), 0)
                if res:
                    self.list.get_selection().select_path(Gtk.TreePath(idx))
                else:
                    self.view.get_buffer().set_text('')
                return False
            GLib.idle_add(done)
        threading.Thread(target=work, daemon=True).start()

    def show_selected(self):
        t = self.selected()
        buf = self.view.get_buffer()
        buf.set_text('')
        if not t:
            return
        self.send_btn.set_sensitive(t['status'] != 'closed')
        buf.insert_with_tags_by_name(buf.get_end_iter(), '#%s %s\n' % (t['id'], t['subject']), 'title')
        buf.insert_with_tags_by_name(buf.get_end_iter(), 'Status: %s\n\n' % t['status_text'], 'time')
        newest = 0
        for m in t.get('thread') or []:
            if m.get('tech'):
                newest = max(newest, m['id'])
            buf.insert_with_tags_by_name(buf.get_end_iter(), m.get('author', '') + '  ', 'tech' if m.get('tech') else 'me')
            buf.insert_with_tags_by_name(buf.get_end_iter(), time.strftime('%Y-%m-%d %H:%M', time.localtime(m.get('created_at', 0) / 1000)) + '\n', 'time')
            buf.insert(buf.get_end_iter(), m.get('body', '') + '\n\n')
        self.app.ticket_seen[t['id']] = max(newest, self.app.ticket_seen.get(t['id'], 0))
        GLib.idle_add(lambda: self.view.scroll_to_iter(buf.get_end_iter(), 0, False, 0, 1) and False)

    def reply(self):
        t = self.selected()
        ib = self.input.get_buffer()
        text = ib.get_text(ib.get_start_iter(), ib.get_end_iter(), False).strip()
        if not t or not text:
            return
        self.send_btn.set_sensitive(False)
        self.status.set_text('Sending...')

        def work():
            _, err = self.app.ticket_call('POST', '/api/chat/device/tickets/%d/reply' % t['id'], {'body': text})

            def done():
                self.send_btn.set_sensitive(True)
                if err:
                    self.status.set_text("Couldn't send: %s" % err)
                else:
                    ib.set_text('')
                    self.reload(t['id'])
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
        self.new_ticket = None
        self.ticket_list = None
        self.ticket_seen = {}  # ticket id -> newest IT reply id already seen
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
        nt = Gtk.MenuItem(label='Open a support ticket...')
        nt.connect('activate', lambda *a: self.show_new_ticket())
        self.menu.append(nt)
        mt = Gtk.MenuItem(label='My support tickets...')
        mt.connect('activate', lambda *a: self.show_tickets())
        self.menu.append(mt)
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
        threading.Thread(target=self.ticket_loop, daemon=True).start()

    # ---------- support tickets ----------
    def ticket_call(self, method, path, payload=None):
        """Returns (result, None) or (None, error text)."""
        url = self.chat_url(path)
        if not url:
            return None, 'not connected to the HostPilot server'
        data = None
        if payload is not None:
            payload = dict(payload, author=os.environ.get('USER') or 'User')
            data = json.dumps(payload).encode('utf-8')
        try:
            req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method=method)
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode('utf-8')), None
        except urllib.error.HTTPError as e:
            return None, http_error(e)
        except Exception as e:
            return None, str(e)

    def ticket_loop(self):
        """Every minute: notify when IT support replies to one of this computer's tickets."""
        loaded = False
        while True:
            res, err = self.ticket_call('GET', '/api/chat/device/tickets')
            if not err:
                for t in res:
                    newest = max([m['id'] for m in t.get('thread') or [] if m.get('tech')] or [0])
                    old = self.ticket_seen.get(t['id'])
                    if loaded and newest and (old is None or newest > old):
                        GLib.idle_add(self.on_ticket_reply, t['id'], t['subject'])
                    self.ticket_seen[t['id']] = max(newest, old or 0)
                loaded = True
            time.sleep(60)

    def on_ticket_reply(self, tid, subject):
        notify('IT support replied', 'Ticket #%s: %s\nOpen "My support tickets" from the HostPilot icon to read it.' % (tid, subject[:80]))
        if self.ticket_list and self.ticket_list.get_visible():
            self.ticket_list.reload(tid)
        return False

    def show_new_ticket(self):
        if not self.new_ticket:
            self.new_ticket = NewTicketWindow(self)
        self.new_ticket.show_all()
        self.new_ticket.present()

    def show_tickets(self, select=0):
        if not self.ticket_list:
            self.ticket_list = TicketsWindow(self)
        self.ticket_list.show_all()
        self.ticket_list.present()
        self.ticket_list.reload(select)

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
    # the login screen (gdm, gdm-greeter, lightdm, sddm) isn't a user: no icon there
    import pwd
    try:
        me = pwd.getpwuid(os.getuid()).pw_name
    except KeyError:
        me = ''
    if me.startswith(('gdm', 'lightdm', 'sddm')) or os.environ.get('XDG_SESSION_CLASS') == 'greeter':
        return 0
    # one icon per user session
    run_dir = os.environ.get('XDG_RUNTIME_DIR') or '/tmp'
    lock = open(os.path.join(run_dir, 'hostpilot-tray-%d.lock' % os.getuid()), 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return 0
    global ICONS
    try:
        ICONS = make_icons()
        TrayApp()
    except Exception:
        import traceback
        tlog('failed to start:\n' + traceback.format_exc())
        raise
    session = os.environ.get('XDG_SESSION_TYPE', '?')
    desktop = os.environ.get('XDG_CURRENT_DESKTOP', '?')
    if Indicator:
        tlog('started: %s icon, %s session, desktop %s' % (Indicator.__name__.split('.')[-1], session, desktop))
    else:
        tlog('started WITHOUT AppIndicator (old-style tray icon), %s session, desktop %s' % (session, desktop))
        if 'GNOME' in desktop.upper() or 'KDE' in desktop.upper() or session == 'wayland':
            # GNOME/KDE on Wayland never show old-style tray icons: say so instead of failing silently
            tlog('this desktop needs the AppIndicator library (gir1.2-ayatanaappindicator3-0.1); the agent installs it automatically')
    Gtk.main()
    return 0


def tlog(msg):
    """~/.cache/hostpilot-tray/tray.log: which icon type is used and startup errors (for troubleshooting)."""
    try:
        os.makedirs(CACHE, exist_ok=True)
        path = os.path.join(CACHE, 'tray.log')
        if os.path.exists(path) and os.path.getsize(path) > 200000:
            os.replace(path, path + '.1')
        with open(path, 'a') as f:
            f.write('%s  %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg))
    except OSError:
        pass
    print(msg, file=sys.stderr)


ICONS = {}
if __name__ == '__main__':
    sys.exit(main())
