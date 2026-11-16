#!/usr/bin/env python3
"""Get an OAuth 2 refresh token for the Flare plugin, once, on your own computer.

Flare's in-app OAuth callback changes on every sign-in, and this site only accepts
pre-registered redirect URLs, so you authorize your own app here instead and paste
the result into Flare's "Import tokens" sign-in form.

Usage:
    python3 get_refresh_token.py

Before running, register an app on the site and add this exact redirect URL to it:
    http://localhost:8765/callback

For Tumblr it then shows a page on this computer with a QR code: scan it with your
phone and paste the text into Flare's "Setup code" field, instead of typing three values.

Only Python's standard library is used. Nothing is stored on disk or sent anywhere
except to the site itself; the QR code is made on this computer and the page is only
reachable from this computer.
"""

import base64
import getpass
import html
import http.server
import json
import secrets
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

SERVICE = "tumblr"  # "tumblr" or "reddit"

REDIRECT_URI = "http://localhost:8765/callback"

SERVICES = {
    "tumblr": {
        "name": "Tumblr",
        "apps_url": "https://www.tumblr.com/oauth/apps",
        "authorize": "https://www.tumblr.com/oauth2/authorize",
        "token": "https://api.tumblr.com/v2/oauth2/token",
        "scope": "basic write offline_access",
        "id_label": "OAuth consumer key",
        "secret_label": "OAuth consumer secret",
        "secret_required": True,
        "extra": {},
        "setup_code": True,
    },
    "reddit": {
        "name": "Reddit",
        "apps_url": "https://www.reddit.com/prefs/apps",
        "authorize": "https://www.reddit.com/api/v1/authorize",
        "token": "https://www.reddit.com/api/v1/access_token",
        "scope": "identity read history mysubreddits privatemessages submit vote save edit",
        "id_label": "App client ID",
        "secret_label": "App client secret (leave blank for an 'installed app')",
        "secret_required": False,
        "extra": {"duration": "permanent"},
        "setup_code": False,
    },
}


def main():
    cfg = SERVICES[SERVICE]
    print(f"{cfg['name']} refresh token helper for Flare\n")
    print(f"1. Open {cfg['apps_url']} and create (or edit) an app.")
    print(f"2. Set its redirect URL to exactly: {REDIRECT_URI}\n")
    client_id = input(f"{cfg['id_label']}: ").strip()
    client_secret = getpass.getpass(f"{cfg['secret_label']}: ").strip()
    if not client_id or (cfg["secret_required"] and not client_secret):
        sys.exit("Both values are required.")

    state = secrets.token_urlsafe(16)
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": cfg["scope"],
        "state": state,
        **cfg["extra"],
    }
    url = cfg["authorize"] + "?" + urllib.parse.urlencode(params)

    result = {}
    done = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/callback":
                self.send_response(404)
                self.end_headers()
                return
            query = dict(urllib.parse.parse_qsl(parsed.query))
            result.update(query)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Done. You can close this tab and return to the terminal.")
            done.set()

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 8765), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print("\nOpening your browser to authorize the app. If it doesn't open, visit:\n" + url + "\n")
    webbrowser.open(url)
    done.wait(timeout=600)
    server.shutdown()
    server.server_close()  # free port 8765 right away

    if result.get("state") != state:
        sys.exit("Authorization failed: the state did not match (or timed out).")
    if "error" in result:
        sys.exit("Authorization was denied: " + result["error"])
    code = result.get("code")
    if not code:
        sys.exit("No authorization code was returned.")

    form = {"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI}
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "flare-plugin-token-helper/0.1",
        "Accept": "application/json",
    }
    if SERVICE == "reddit":
        basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        headers["Authorization"] = "Basic " + basic
    else:
        form["client_id"] = client_id
        form["client_secret"] = client_secret

    request = urllib.request.Request(
        cfg["token"], data=urllib.parse.urlencode(form).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")
        hint = ""
        if "invalid_client" in body:
            hint = ("\nThe app's secret was rejected. Copy it again from " + cfg["apps_url"] +
                    " (click to show it), from the same app as the key, and run this again.")
        sys.exit(f"Token exchange failed (HTTP {error.code}): {body}{hint}")

    refresh = data.get("refresh_token")
    if not refresh:
        sys.exit("No refresh token was returned: " + json.dumps(data))

    if cfg.get("setup_code"):
        show_setup_code(cfg, client_id, client_secret, refresh)
        return

    print("Success. In Flare, add an account, choose " + cfg["name"] + " and paste:\n")
    print(f"  {cfg['id_label']}: {client_id}")
    if client_secret:
        print(f"  {cfg['secret_label'].split(' (')[0]}: (the secret you entered above)")
    print(f"  Refresh token: {refresh}\n")
    print("Keep the refresh token private; it gives access to your account.")


def setup_code(client_id, client_secret, refresh):
    """One line holding all three values; the Flare plugin's "Setup code" field reads it."""
    quote = lambda v: urllib.parse.quote(v, safe="")
    return f"flare-{SERVICE}:{quote(client_id)}:{quote(client_secret)}:{quote(refresh)}"


def show_setup_code(cfg, client_id, client_secret, refresh):
    code = setup_code(client_id, client_secret, refresh)
    page_path = "/setup/" + secrets.token_urlsafe(16)
    page = SETUP_PAGE.format(
        name=html.escape(cfg["name"]),
        svg=qr_svg(code),
        code=html.escape(code),
    ).encode()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != page_path:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
            self.end_headers()
            self.wfile.write(page)

        def log_message(self, *args):
            pass

    print("Success.\n")
    try:
        # Any free port: the sign-in listener's port may still be in use.
        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    except OSError as error:
        print(f"Couldn't start the QR code page ({error}). Paste this setup code into Flare instead:\n")
        print("  " + code + "\n")
        print("The setup code holds your app secret and refresh token: don't share or post it.")
        return
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}{page_path}"
    print("Opening a page with your setup code as a QR code. If it doesn't open, visit:\n" + url + "\n")
    print("On your phone: scan the QR code with the camera (or Google Lens), copy the text,")
    print("then in Flare add an account with api.tumblr.com as the server, choose")
    print(cfg["name"] + " and paste it into \"Setup code\". On this computer, copy it from the page.\n")
    print("The setup code holds your app secret and refresh token: don't share or post it.")
    if cfg["name"] == "Tumblr":
        print("\nFor another of your blogs, run this again for a new setup code and type that")
        print("blog's name into \"Blog\" in Flare. Each blog needs its own setup code.\n")
    webbrowser.open(url)
    try:
        input("Press Enter here when you're done to close the page... ")
    except (EOFError, KeyboardInterrupt):
        print()
    server.shutdown()
    server.server_close()
    print("Closed. Reload the page and it's gone.")


SETUP_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>{name} setup code</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 2rem auto; padding: 0 1rem; }}
  .qr {{ background: #fff; padding: 8px; display: inline-block; border-radius: 8px; }}
  .qr svg {{ width: min(360px, 90vw); height: auto; display: block; }}
  textarea {{ width: 100%; font: 13px ui-monospace, monospace; padding: .5rem; box-sizing: border-box; }}
  .warn {{ padding: .75rem 1rem; border-left: 4px solid #d97706; background: rgba(217,119,6,.1); }}
</style></head><body>
<h1>{name} setup code for Flare</h1>
<ol>
  <li>Scan this QR code with your phone's camera (or Google Lens) and copy the text it shows.</li>
  <li>In Flare, add an account, type <b>api.tumblr.com</b> as the server and choose {name}.</li>
  <li>Paste the text into <b>Setup code</b> and leave the other three fields empty.</li>
</ol>
<div class="qr">{svg}</div>
<p>On this computer, copy the setup code instead:</p>
<textarea rows="4" readonly>{code}</textarea>
<p class="warn">This code contains your app secret and refresh token. Anyone who scans or copies it
can use your Tumblr account. Don't share it, post it or screenshot it. Press Enter in the terminal
when you're done to take this page down.</p>
</body></html>
"""


# --------------------------------------------------------------------- QR code
# A small QR encoder (byte mode, error correction level M, versions 1-20) so the
# setup code never goes to an outside QR service.

# Version -> (EC codewords per block, [(blocks, data codewords per block), ...]) for level M.
_QR_M = {
    1: (10, [(1, 16)]), 2: (16, [(1, 28)]), 3: (26, [(1, 44)]), 4: (18, [(2, 32)]),
    5: (24, [(2, 43)]), 6: (16, [(4, 27)]), 7: (18, [(4, 31)]), 8: (22, [(2, 38), (2, 39)]),
    9: (22, [(3, 36), (2, 37)]), 10: (26, [(4, 43), (1, 44)]), 11: (30, [(1, 50), (4, 51)]),
    12: (22, [(6, 36), (2, 37)]), 13: (22, [(8, 37), (1, 38)]), 14: (24, [(4, 40), (5, 41)]),
    15: (24, [(5, 41), (5, 42)]), 16: (28, [(7, 45), (3, 46)]), 17: (28, [(10, 46), (1, 47)]),
    18: (26, [(9, 43), (4, 44)]), 19: (26, [(3, 44), (11, 45)]), 20: (26, [(3, 41), (13, 42)]),
}

_GF_EXP = [0] * 512
_GF_LOG = [0] * 256
_x = 1
for _i in range(255):
    _GF_EXP[_i] = _x
    _GF_LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _GF_EXP[_i] = _GF_EXP[_i - 255]


def _rs_remainder(data, degree):
    gen = [1]
    for i in range(degree):
        nxt = [0] * (len(gen) + 1)
        for j, g in enumerate(gen):
            nxt[j] ^= g
            if g:
                nxt[j + 1] ^= _GF_EXP[_GF_LOG[g] + i]
        gen = nxt
    rem = list(data) + [0] * degree
    for i in range(len(data)):
        coef = rem[i]
        if coef:
            for j in range(1, len(gen)):
                if gen[j]:
                    rem[i + j] ^= _GF_EXP[_GF_LOG[gen[j]] + _GF_LOG[coef]]
    return rem[len(data):]


def _bch(value, poly, shift):
    v = value << shift
    top = poly.bit_length() - 1
    while v.bit_length() - 1 >= top:
        v ^= poly << (v.bit_length() - 1 - top)
    return (value << shift) | v


def _alignment(version):
    if version == 1:
        return []
    n = version // 7 + 2
    size = version * 4 + 17
    step = 26 if version == 32 else (version * 4 + n * 2 + 1) // (n * 2 - 2) * 2
    return [6] + [size - 7 - i * step for i in range(n - 1)][::-1]


def qr_matrix(text, force_mask=None):
    """Returns a square list of lists of booleans (True = dark) for `text`."""
    data = text.encode("utf-8")
    for version in range(1, 21):
        ec, groups = _QR_M[version]
        capacity = sum(b * d for b, d in groups)
        count_bits = 8 if version < 10 else 16
        if 4 + count_bits + len(data) * 8 <= capacity * 8:
            break
    else:
        raise ValueError("too long for a QR code")

    bits = [0, 1, 0, 0] + [(len(data) >> i) & 1 for i in range(count_bits - 1, -1, -1)]
    for byte in data:
        bits += [(byte >> i) & 1 for i in range(7, -1, -1)]
    bits += [0] * min(4, capacity * 8 - len(bits))
    bits += [0] * (-len(bits) % 8)
    codewords = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = 0
    while len(codewords) < capacity:
        codewords.append(0xEC if pad % 2 == 0 else 0x11)
        pad += 1

    blocks, pos = [], 0
    for count, size in groups:
        for _ in range(count):
            blocks.append(codewords[pos:pos + size])
            pos += size
    ecc = [_rs_remainder(b, ec) for b in blocks]
    final = []
    for i in range(max(len(b) for b in blocks)):
        final += [b[i] for b in blocks if i < len(b)]
    for i in range(ec):
        final += [e[i] for e in ecc]

    n = version * 4 + 17
    grid = [[False] * n for _ in range(n)]
    used = [[False] * n for _ in range(n)]

    def put(r, c, dark):
        grid[r][c] = dark
        used[r][c] = True

    for r0, c0 in ((0, 0), (0, n - 7), (n - 7, 0)):
        for r in range(-1, 8):
            for c in range(-1, 8):
                rr, cc = r0 + r, c0 + c
                if 0 <= rr < n and 0 <= cc < n:
                    ring = max(abs(r - 3), abs(c - 3))
                    put(rr, cc, ring != 2 and ring != 4)
    for i in range(8, n - 8):
        put(6, i, i % 2 == 0)
        put(i, 6, i % 2 == 0)
    centers = _alignment(version)
    last = centers[-1] if centers else 0
    for r in centers:
        for c in centers:
            if (r, c) in ((6, 6), (6, last), (last, 6)):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    put(r + dr, c + dc, max(abs(dr), abs(dc)) != 1)
    put(n - 8, 8, True)  # dark module
    for i in range(9):  # reserve format areas
        for r, c in ((8, i), (i, 8)):
            if not used[r][c]:
                used[r][c] = True
    for i in range(8):
        used[8][n - 1 - i] = True
        used[n - 1 - i][8] = True
    if version >= 7:
        info = _bch(version, 0x1F25, 12)
        for i in range(18):
            dark = bool((info >> i) & 1)
            a, b = n - 11 + i % 3, i // 3
            put(a, b, dark)
            put(b, a, dark)

    bitstream = [(cw >> i) & 1 for cw in final for i in range(7, -1, -1)]
    cells = []
    right = n - 1
    upward = True
    while right > 0:
        if right == 6:
            right -= 1
        rows = range(n - 1, -1, -1) if upward else range(n)
        for r in rows:
            for c in (right, right - 1):
                if not used[r][c]:
                    cells.append((r, c))
        upward = not upward
        right -= 2
    for k, (r, c) in enumerate(cells):
        grid[r][c] = bool(bitstream[k]) if k < len(bitstream) else False

    masks = [
        lambda r, c: (r + c) % 2 == 0, lambda r, c: r % 2 == 0, lambda r, c: c % 3 == 0,
        lambda r, c: (r + c) % 3 == 0, lambda r, c: (r // 2 + c // 3) % 2 == 0,
        lambda r, c: (r * c) % 2 + (r * c) % 3 == 0, lambda r, c: ((r * c) % 2 + (r * c) % 3) % 2 == 0,
        lambda r, c: ((r + c) % 2 + (r * c) % 3) % 2 == 0,
    ]

    def build(mask):
        g = [row[:] for row in grid]
        fn = masks[mask]
        for r, c in cells:
            if fn(r, c):
                g[r][c] = not g[r][c]
        fmt = _bch((0b00 << 3) | mask, 0x537, 10) ^ 0x5412  # level M = 00
        for i in range(15):
            dark = bool((fmt >> i) & 1)
            if i < 6:
                g[i][8] = dark
            elif i < 8:
                g[i + 1][8] = dark
            else:
                g[n - 15 + i][8] = dark
            if i < 8:
                g[8][n - 1 - i] = dark
            elif i < 9:
                g[8][15 - i] = dark
            else:
                g[8][14 - i] = dark
        g[n - 8][8] = True
        return g

    def penalty(g):
        score = 0
        for lines in (g, list(map(list, zip(*g)))):
            for line in lines:
                run, prev = 0, None
                for v in line:
                    if v == prev:
                        run += 1
                    else:
                        if run >= 5:
                            score += run - 2
                        run, prev = 1, v
                if run >= 5:
                    score += run - 2
                s = "".join("1" if v else "0" for v in line)
                for pat in ("10111010000", "00001011101"):
                    i = s.find(pat)
                    while i >= 0:
                        score += 40
                        i = s.find(pat, i + 1)
        for r in range(n - 1):
            for c in range(n - 1):
                if g[r][c] == g[r][c + 1] == g[r + 1][c] == g[r + 1][c + 1]:
                    score += 3
        dark = sum(map(sum, g))
        score += abs(dark * 20 - n * n * 10) // (n * n) * 10
        return score

    if force_mask is not None:
        return build(force_mask)
    return min((build(m) for m in range(8)), key=penalty)


def qr_svg(text, scale=8, border=4):
    m = qr_matrix(text)
    n = len(m)
    size = (n + border * 2) * scale
    path = "".join(
        f"M{(c + border) * scale},{(r + border) * scale}h{scale}v{scale}h-{scale}z"
        for r in range(n) for c in range(n) if m[r][c]
    )
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 {size} {size}" shape-rendering="crispEdges">'
            f'<rect width="100%" height="100%" fill="#fff"/><path d="{path}" fill="#000"/></svg>')


if __name__ == "__main__":
    main()
