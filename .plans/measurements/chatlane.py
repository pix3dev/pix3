# -*- coding: utf-8 -*-
"""Chat lane of the Vibe-vs-chat gap measurement.

One-shot HTML/JS game generation through the local pix3-agent-bridge (Claude Code MAX lane,
no tools => a plain single-turn completion, the closest honest analogue of asking in chat).
Everything stays inside Python with explicit UTF-8 so the Russian prompt is not mangled by
the Windows shell on the way to the model.
"""
import json
import os
import re
import time
import urllib.request

OUT = r"C:\Projects\pix3-stuff\pix3\.plans\measurements\chat"
BRIDGE = "http://127.0.0.1:8484/v1/messages"
MODEL = "claude-sonnet-5"

PROMPTS = [
    ("p1-tapper", "тапалка про монетки"),
    ("p2-snake", "змейка"),
    ("p3-flappy", "флоппи-бёрд"),
    ("p4-tetris", "тетрис"),
]

with open(os.path.expanduser("~/.pix3/agent-bridge.json"), encoding="utf-8") as fh:
    cfg = json.load(fh)
TOKEN = next(v for k, v in cfg.items() if "oken" in k)


def ask(idea):
    payload = {
        "model": MODEL,
        "max_tokens": 16000,
        "messages": [
            {"role": "user", "content": "сделай html/js страничку — игру: " + idea}
        ],
    }
    req = urllib.request.Request(
        BRIDGE,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "content-type": "application/json; charset=utf-8",
            "x-pix3-bridge-token": TOKEN,
        },
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=600) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    return time.time() - t0, body


def extract_html(text):
    blocks = re.findall(r"```(?:html)?\s*\n(.*?)```", text, re.S)
    for b in blocks:
        if "<html" in b.lower() or "<!doctype" in b.lower():
            return b
    return blocks[0] if blocks else None


os.makedirs(OUT, exist_ok=True)
for slug, idea in PROMPTS:
    secs, body = ask(idea)
    with open(os.path.join(OUT, slug + ".json"), "w", encoding="utf-8") as fh:
        json.dump(body, fh, ensure_ascii=False, indent=1)
    text = "".join(c.get("text", "") for c in body.get("content", []))
    html = extract_html(text)
    if html:
        with open(os.path.join(OUT, slug + ".html"), "w", encoding="utf-8") as fh:
            fh.write(html)
    usage = body.get("usage", {})
    print(
        "%-10s %5.1fs  stop=%-9s out_tok=%-6s html=%s"
        % (
            slug,
            secs,
            body.get("stop_reason"),
            usage.get("output_tokens"),
            len(html) if html else "NONE",
        ),
        flush=True,
    )
print("ALL DONE")
