#!/usr/bin/env python3
import functools
import http.server
import json
import os
import queue
import random
import re
import signal
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from urllib.parse import urlparse


def find_port(start=4173):
    for port in range(start, start + 100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("No available local port found.")


ROOMS = {}
tunnel_process = None
server = None
CLOUDFLARED_CANDIDATES = [
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "cloudflared",
]


def make_room_code(prefix="SPADES"):
    while True:
        code = f"{prefix}-{random.randint(1000, 9999)}"
        if code not in ROOMS:
            return code


class SpadesHandler(http.server.SimpleHTTPRequestHandler):
    def _send_json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        parts = parsed.path.strip("/").split("/")
        if parsed.path == "/api/health":
            self._send_json(200, {"ok": True})
            return
        if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "state":
            room = ROOMS.get(parts[2].upper())
            if not room:
                self._send_json(404, {"error": "room not found"})
                return
            self._send_json(200, {"state": room["state"]})
            return
        if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "actions":
            room = ROOMS.get(parts[2].upper())
            if not room:
                self._send_json(404, {"error": "room not found"})
                return
            since = int(dict(item.split("=", 1) for item in parsed.query.split("&") if "=" in item).get("since", 0) or 0)
            actions = [item for item in room["actions"] if item["seq"] > since]
            self._send_json(200, {"actions": actions})
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        parts = parsed.path.strip("/").split("/")
        if parsed.path == "/api/rooms":
            body = self._read_json()
            game = (body.get("state") or {}).get("game")
            prefix = "CARDS" if game == "handfoot" else "SPADES"
            code = make_room_code(prefix)
            ROOMS[code] = {"state": body.get("state"), "actions": [], "next_seq": 1}
            self._send_json(201, {"room": code})
            return
        if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "actions":
            room = ROOMS.get(parts[2].upper())
            if not room:
                self._send_json(404, {"error": "room not found"})
                return
            action = self._read_json().get("action")
            seq = room["next_seq"]
            room["next_seq"] += 1
            room["actions"].append({"seq": seq, "action": action})
            self._send_json(201, {"seq": seq})
            return
        self._send_json(404, {"error": "not found"})

    def do_PUT(self):
        parsed = urlparse(self.path)
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "state":
            room = ROOMS.get(parts[2].upper())
            if not room:
                self._send_json(404, {"error": "room not found"})
                return
            room["state"] = self._read_json().get("state")
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"error": "not found"})


def run_localhost_run(port):
    global tunnel_process
    print("Starting localhost.run tunnel.", flush=True)
    tunnel_process = subprocess.Popen(
        [
            "/usr/bin/ssh",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ServerAliveInterval=60",
            "-R",
            f"80:127.0.0.1:{port}",
            "nokey@localhost.run",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    return monitor_tunnel(tunnel_process, r"https://[-a-z0-9]+\.lhr\.life", "localhost.run")


def run_cloudflared(local_url):
    global tunnel_process
    cloudflared_bin = next((path for path in CLOUDFLARED_CANDIDATES if shutil.which(path)), None)
    if not cloudflared_bin:
        raise FileNotFoundError("cloudflared")
    print("Starting Cloudflare Tunnel.", flush=True)
    tunnel_process = subprocess.Popen(
        [cloudflared_bin, "tunnel", "--url", local_url],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    return monitor_tunnel(tunnel_process, r"https://[-a-z0-9]+\.trycloudflare\.com", "Cloudflare")


def monitor_tunnel(process, url_pattern, label):
    lines = queue.Queue()
    assert process.stdout is not None

    def collect_output():
        for line in process.stdout:
            lines.put(line)

    threading.Thread(target=collect_output, daemon=True).start()
    tunnel_url = None
    deadline = None
    opened_tunnel = False

    while process.poll() is None:
        try:
            line = lines.get(timeout=0.5)
            print(line, end="", flush=True)
            match = re.search(url_pattern, line)
            if match and not tunnel_url:
                tunnel_url = match.group(0)
                deadline = time.time() + 30
        except queue.Empty:
            pass

        if tunnel_url and not opened_tunnel and url_works(tunnel_url):
            webbrowser.open(tunnel_url)
            print(f"Remote Spades public URL: {tunnel_url}", flush=True)
            opened_tunnel = True

        if tunnel_url and not opened_tunnel and deadline and time.time() > deadline:
            print(f"{label} URL did not become reachable: {tunnel_url}", flush=True)
            process.terminate()
            return False

    return opened_tunnel


def url_works(base_url):
    try:
        with urllib.request.urlopen(f"{base_url}/api/health", timeout=3) as response:
            return response.status == 200
    except Exception:
        return False


def read_hosted_url(site_dir):
    candidates = [
        os.path.join(os.path.dirname(site_dir), "hosted_url.txt"),
        os.path.join(site_dir, "hosted_url.txt"),
    ]
    for candidate in candidates:
        try:
            with open(candidate, "r", encoding="utf-8") as handle:
                url = handle.read().strip()
        except OSError:
            continue
        if url.startswith("http://") or url.startswith("https://"):
            return url
    return None


def main():
    global tunnel_process
    global server
    if len(sys.argv) != 2:
        raise SystemExit("Usage: launcher.py SITE_DIRECTORY")

    site_dir = sys.argv[1]
    hosted_url = read_hosted_url(site_dir)
    if hosted_url:
        print(f"Opening hosted Remote Card Table: {hosted_url}", flush=True)
        webbrowser.open(hosted_url)
        signal.pause()
        return

    port = find_port()
    handler = functools.partial(SpadesHandler, directory=site_dir)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    local_url = f"http://127.0.0.1:{port}/"

    def shutdown(signum=None, frame=None):
        if tunnel_process and tunnel_process.poll() is None:
            tunnel_process.terminate()
        if server:
            server.shutdown()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    print(f"Remote Spades serving {site_dir} at {local_url}", flush=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        if run_localhost_run(port):
            shutdown()
            return
    except FileNotFoundError:
        pass

    try:
        if run_cloudflared(local_url):
            shutdown()
            return
    except FileNotFoundError:
        pass

    print("No verified tunnel is available. Opening local table only.", flush=True)
    webbrowser.open(local_url)
    signal.pause()

    shutdown()


if __name__ == "__main__":
    main()
