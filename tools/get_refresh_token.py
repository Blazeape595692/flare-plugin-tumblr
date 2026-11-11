#!/usr/bin/env python3
"""Get an OAuth 2 refresh token for the Flare plugin, once, on your own computer.

Flare's in-app OAuth callback changes on every sign-in, and this site only accepts
pre-registered redirect URLs, so you authorize your own app here instead and paste
the result into Flare's "Import tokens" sign-in form.

Usage:
    python3 get_refresh_token.py

Before running, register an app on the site and add this exact redirect URL to it:
    http://localhost:8765/callback

Only Python's standard library is used. Nothing is stored on disk; the tokens are
printed to this terminal only.
"""

import base64
import getpass
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
        sys.exit(f"Token exchange failed (HTTP {error.code}): {error.read().decode(errors='replace')}")

    refresh = data.get("refresh_token")
    if not refresh:
        sys.exit("No refresh token was returned: " + json.dumps(data))

    print("Success. In Flare, add an account, choose " + cfg["name"] + " and paste:\n")
    print(f"  {cfg['id_label']}: {client_id}")
    if client_secret:
        print(f"  {cfg['secret_label'].split(' (')[0]}: (the secret you entered above)")
    print(f"  Refresh token: {refresh}\n")
    print("Keep the refresh token private; it gives access to your account.")


if __name__ == "__main__":
    main()
