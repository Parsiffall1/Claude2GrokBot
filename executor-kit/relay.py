#!/usr/bin/env python3
"""Claude2GrokBot executor client (Python 3.8+, standard library only).

Talks to a Claude2GrokBot server over outbound HTTPS. No daemon, no open port.

Configuration (environment variables, or KEY=VALUE lines in ~/.config/claude2grokbot/executor.env):
  RELAY_URL            e.g. https://claude2grokbot.<you>.workers.dev
  RELAY_EXECUTOR_KEY   the EXECUTOR_KEY secret you set on the server
  RELAY_EXECUTOR       optional executor name (default: server default)

Everyday commands (the result token is kept in ~/.claude2grokbot/current.json, never printed):
  relay.py ping                         check URL + key
  relay.py next                         claim the next task and print it   (exit 3 = no task)
  relay.py heartbeat ["note"]           keep the lease alive on long tasks
  relay.py block "why"                  you must wait for your user; keeps the task for 24h
  relay.py attach FILE [FILE...]        upload files or screenshots for the current task (before `done`)
  relay.py done completed RESULT_FILE   upload the result ("-" reads stdin); also: failed
"""
import json
import mimetypes
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

VERSION = "0.1.0"
STATE_DIR = pathlib.Path.home() / ".claude2grokbot"
STATE_FILE = STATE_DIR / "current.json"
CONFIG_FILE = pathlib.Path(os.environ.get("CLAUDE2GROKBOT_CONFIG", pathlib.Path.home() / ".config" / "claude2grokbot" / "executor.env"))
NO_TASK_EXIT = 3


def die(msg, code=1):
    print(f"claude2grokbot: {msg}", file=sys.stderr)
    sys.exit(code)


def load_config():
    conf = {}
    if CONFIG_FILE.exists():
        for line in CONFIG_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                conf[k.strip()] = v.strip().strip('"').strip("'")
    url = os.environ.get("RELAY_URL") or conf.get("RELAY_URL")
    key = os.environ.get("RELAY_EXECUTOR_KEY") or conf.get("RELAY_EXECUTOR_KEY")
    executor = os.environ.get("RELAY_EXECUTOR") or conf.get("RELAY_EXECUTOR") or ""
    if not url or not key:
        die(f"RELAY_URL and RELAY_EXECUTOR_KEY must be set (env vars or {CONFIG_FILE})", 2)
    return url.rstrip("/"), key, executor


def request(method, url, body=None, key=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", f"claude2grokbot-relay-py/{VERSION}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode("utf-8")
            return res.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"error": raw[:300]}
    except urllib.error.URLError as e:
        die(f"cannot reach {url}: {e.reason}")


TERMINAL = ("completed", "failed", "canceled", "rejected")


def task_is_gone(status, body):
    """403 = token no longer valid; 409 with a terminal state = canceled/finished elsewhere."""
    return status == 403 or (status == 409 and isinstance(body, dict) and body.get("state") in TERMINAL)


def save_state(data):
    STATE_DIR.mkdir(mode=0o700, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, STATE_FILE)


def load_state():
    if not STATE_FILE.exists():
        die("no current task (run `relay.py next` first)", 2)
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def cmd_ping(url, key, executor):
    status, body = request("GET", f"{url}/executor/ping", key=key)
    if status != 200:
        die(f"ping failed: HTTP {status} {body}")
    print(json.dumps(body, indent=2))


def cmd_next(url, key, executor):
    if STATE_FILE.exists():
        cur = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        print(f"claude2grokbot: note: task {cur['task_id']} was never finished; claiming a new one anyway", file=sys.stderr)
    status, body = request("POST", f"{url}/executor/claim", {"executor": executor} if executor else {}, key=key)
    if status == 204:
        print("NO_TASK")
        sys.exit(NO_TASK_EXIT)
    if status != 200:
        die(f"claim failed: HTTP {status} {body}")
    task = body["task"]
    save_state({"task_id": task["id"], "result_token": body["result_token"], "result_url": body["result_url"],
                "heartbeat_url": body["heartbeat_url"], "attachment_url": body.get("attachment_url")})
    print(json.dumps({**task, "lease_expires_at": body["lease_expires_at"], "rules": body.get("rules", [])}, ensure_ascii=False, indent=2))


def cmd_attach(paths):
    if not paths:
        die("usage: relay.py attach FILE [FILE...]", 2)
    st = load_state()
    url = st.get("attachment_url") or st["result_url"].replace("/executor/result", "/executor/attachment")
    for path in paths:
        f = pathlib.Path(path)
        if not f.is_file():
            die(f"not a file: {path}", 2)
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        req = urllib.request.Request(url, data=f.read_bytes(), method="POST")
        req.add_header("User-Agent", f"claude2grokbot-relay-py/{VERSION}")
        req.add_header("Content-Type", ctype)
        req.add_header("X-Task-Id", st["task_id"])
        req.add_header("X-Result-Token", st["result_token"])
        req.add_header("X-Filename", urllib.parse.quote(f.name))
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                status, body = res.status, json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                status, body = e.code, json.loads(raw)
            except ValueError:
                status, body = e.code, {"error": raw[:300]}
        except urllib.error.URLError as e:
            die(f"cannot reach {url}: {e.reason}")
        if status != 200:
            if task_is_gone(status, body):
                STATE_FILE.unlink(missing_ok=True)
            die(f"attach failed for {path}: HTTP {status} {body}")
        print(json.dumps(body, ensure_ascii=False))


def post_result(status_value, result=None, error=None, note=None, keep=False):
    st = load_state()
    payload = {"task_id": st["task_id"], "result_token": st["result_token"], "status": status_value}
    if result is not None:
        payload["result"] = result
    if error is not None:
        payload["error"] = error
    if note is not None:
        payload["note"] = note
    status, body = request("POST", st["result_url"], payload)
    if status != 200:
        if task_is_gone(status, body):
            STATE_FILE.unlink(missing_ok=True)  # task was canceled / reassigned: stop working on it
        die(f"result rejected: HTTP {status} {body}")
    if not keep:
        STATE_FILE.unlink(missing_ok=True)
    print(json.dumps(body, ensure_ascii=False, indent=2))


def read_text(path):
    if path == "-":
        return sys.stdin.read()
    return pathlib.Path(path).read_text(encoding="utf-8")


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        return
    cmd, args = argv[1], argv[2:]
    if cmd in ("ping", "next"):
        url, key, executor = load_config()
        {"ping": cmd_ping, "next": cmd_next}[cmd](url, key, executor)
    elif cmd == "heartbeat":
        st = load_state()
        status, body = request("POST", st["heartbeat_url"], {"task_id": st["task_id"], "result_token": st["result_token"], "note": " ".join(args) or None})
        if status != 200:
            if task_is_gone(status, body):
                STATE_FILE.unlink(missing_ok=True)
            die(f"heartbeat rejected (stop working on this task): HTTP {status} {body}")
        print(json.dumps(body, indent=2))
    elif cmd == "attach":
        cmd_attach(args)
    elif cmd == "block":
        post_result("blocked", note=" ".join(args) or "waiting for user", keep=True)
    elif cmd == "done":
        if not args or args[0] not in ("completed", "failed"):
            die("usage: relay.py done completed|failed RESULT_FILE|- [error message]", 2)
        result = read_text(args[1]) if len(args) > 1 else None
        error = " ".join(args[2:]) or None
        post_result(args[0], result=result, error=error if args[0] == "failed" else None)
    else:
        die(f"unknown command {cmd!r}; see relay.py --help", 2)


if __name__ == "__main__":
    main(sys.argv)
