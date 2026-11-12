#!/usr/bin/env python3
"""A listening test: can a live voice model hold a conversation in Levantine?

The app refuses to ship speech nobody has listened to, and a live conversation
is speech nobody *can* listen to first. So before a Talk tab is worth building,
someone has to sit through ten turns of it and decide whether what comes back
is شامي or Modern Standard with an accent. This serves the page that does that.

    OPENAI_API_KEY=sk-... python3 tools/talk_test.py
    # then open http://localhost:8765

The key stays in this process: the page posts its WebRTC offer here and this
forwards it to the provider, so the browser never sees the key and there is no
cross-origin question to answer. Audio flows directly between the browser and
the provider. Nothing is written to disk.

The page can also call the provider straight from the browser with a key typed
into it. That is the experiment that decides whether a Talk tab could live in
the static app with no server at all.

The request shape follows the open-source Mural client (MIT), which is where
the session endpoint, the model name and the data-channel events come from.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPSTREAM = "https://api.openai.com/v1/live/sessions"
PAGES = {
    "/": ("talk_test.html", "text/html; charset=utf-8"),
    "/prompt": ("talk_prompt.txt", "text/plain; charset=utf-8"),
}
MAX_BODY = 512 * 1024


class Handler(BaseHTTPRequestHandler):
    upstream = UPSTREAM

    def _send(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        page = PAGES.get(self.path.split("?")[0])
        if not page:
            return self._send(404, "not found", "text/plain")
        self._send(200, (HERE / page[0]).read_bytes(), page[1])

    def do_POST(self):
        if self.path != "/session":
            return self._send(404, "not found", "text/plain")
        key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not key:
            return self._send(500, json.dumps({"error": {
                "message": "OPENAI_API_KEY is not set in the shell that started talk_test.py."}}))
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            return self._send(400, json.dumps({"error": {"message": "bad request size"}}))
        request = urllib.request.Request(
            self.upstream, data=self.rfile.read(length), method="POST",
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                self._send(response.status, response.read())
        except urllib.error.HTTPError as error:
            # Pass the provider's own message through: "model not found" and
            # "insufficient quota" are answers to the experiment, not noise.
            self._send(error.code, error.read() or b"{}")
        except (urllib.error.URLError, TimeoutError) as error:
            self._send(502, json.dumps({"error": {"message": f"could not reach the provider: {error}"}}))

    def log_message(self, fmt, *args):
        sys.stderr.write("  " + fmt % args + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--upstream", default=UPSTREAM, help=argparse.SUPPRESS)
    args = parser.parse_args()
    Handler.upstream = args.upstream
    if not os.environ.get("OPENAI_API_KEY"):
        print("note: OPENAI_API_KEY is not set; only the page's direct mode will work.")
    # Loopback only: this process holds a billable key.
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Listening test: http://localhost:{args.port}   (Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
