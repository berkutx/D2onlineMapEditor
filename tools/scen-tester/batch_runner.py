# -*- coding: utf-8 -*-
"""batch_runner.py -- feed a folder of .sg maps to ScenEdit via scen_tester --auto and
collect PASS/REJECT verdicts. Serial by default; GC_PAR=N runs N workers over N junction
clones of the game dir (see make_clones.ps1), starts staggered by GC_STAGGER seconds
(default 5 -- the editor takes a DB lock while loading, simultaneous loads collide).

  python batch_runner.py <maps-dir-or-files...>

Env:
  GC_TAG      output subdir under GC_OUT (default "default"); summary.json is resumable:
              maps already PASS/REJECT are skipped, FLOW rows re-run.
  GC_OUT      output root (default <this dir>\runs)
  GC_EDITOR   serial-mode editor exe (default C:\GOG Games\last_version\Game\ScenEdit.exe)
  GC_CLONES   parallel-mode clone pattern with {n} (default C:\GOG Games\last_version\Game_gc{n}\ScenEdit.exe)
  GC_PAR      worker count (default 1)
  GC_STAGGER  seconds between worker starts (default 5)

Verdicts: PASS (load confirmed + sequence done, no findings), REJECT (validator findings;
reasons captured), FLOW (UI drive did not complete -- rerun).
"""
import io
import json
import os
import subprocess
import sys
import threading
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TOOLS = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.environ.get("GC_OUT", os.path.join(TOOLS, "runs")),
                   os.environ.get("GC_TAG", "default"))
SUMMARY = os.path.join(OUT, "summary.json")
EDITOR = os.environ.get("GC_EDITOR", r"C:\GOG Games\last_version\Game\ScenEdit.exe")
CLONES = os.environ.get("GC_CLONES", r"C:\GOG Games\last_version\Game_gc{n}\ScenEdit.exe")
PAR = max(1, int(os.environ.get("GC_PAR", "1")))
STAGGER = float(os.environ.get("GC_STAGGER", "5"))

_lock = threading.Lock()


def run_one(map_path, tag, editor):
    mb = os.path.getsize(map_path) / 1048576.0
    timeout_s = 80 if mb < 0.7 else (120 if mb < 1.6 else 160)
    log = os.path.join(OUT, tag + ".log")
    res = os.path.join(OUT, tag + ".json")
    try:
        subprocess.run(
            [sys.executable, os.path.join(TOOLS, "scen_tester.py"), "--auto",
             "--map", map_path, "--editor", editor,
             "--timeout", str(timeout_s), "--log", log, "--result", res],
            cwd=TOOLS, timeout=timeout_s + 90,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return {"map": os.path.basename(map_path), "verdict": "FLOW", "why": "runner timeout"}
    findings = []
    try:
        with io.open(res, "r", encoding="utf-8") as f:
            findings = json.load(f)
    except Exception:
        pass
    text = ""
    try:
        with io.open(log, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except Exception:
        pass
    loaded = "load confirmed=True" in text
    done = "sequence done" in text
    rejected = "SCENARIO REJECTED" in text or len(findings) > 0
    verdict = "REJECT" if rejected else ("PASS" if (loaded and done) else "FLOW")
    reasons = []
    for fnd in findings if isinstance(findings, list) else []:
        reasons.append(fnd.get("reason") or fnd.get("diagnostic") or str(fnd)[:120])
    return {"map": os.path.basename(map_path), "verdict": verdict,
            "loaded": loaded, "done": done, "reasons": reasons[:3]}


def main():
    os.makedirs(OUT, exist_ok=True)
    maps = sys.argv[1:]
    if len(maps) == 1 and os.path.isdir(maps[0]):
        d = maps[0]
        maps = [os.path.join(d, n) for n in sorted(os.listdir(d)) if n.lower().endswith(".sg")]
    rows = []
    if os.path.isfile(SUMMARY):
        with io.open(SUMMARY, "r", encoding="utf-8") as f:
            rows = json.load(f)
    seen = {r["map"] for r in rows if r.get("verdict") in ("PASS", "REJECT")}
    todo = [m for m in maps if os.path.basename(m) not in seen]
    total = len(todo)
    counter = {"i": 0}

    def record(row):
        with _lock:
            nonlocal rows
            rows = [r for r in rows if r["map"] != row["map"]] + [row]
            with io.open(SUMMARY, "w", encoding="utf-8") as f:
                json.dump(rows, f, ensure_ascii=False, indent=1)
            counter["i"] += 1
            print("[%d/%d] %-45s %s %s" % (counter["i"], total, row["map"][:45],
                                           row["verdict"], "; ".join(row.get("reasons") or [])[:80]))
            sys.stdout.flush()

    def worker(w, chunk):
        time.sleep(w * STAGGER)  # DB lock on load: never start two editors at once
        editor = EDITOR if PAR == 1 else CLONES.replace("{n}", str(w + 1))
        for i, m in enumerate(chunk):
            tag = "w%d_%03d_%s" % (w, i, "".join(c if c.isalnum() else "_" for c in os.path.basename(m))[:40])
            record(run_one(m, tag, editor))
            time.sleep(2)

    if PAR == 1:
        worker(0, todo)
    else:
        chunks = [todo[i::PAR] for i in range(PAR)]
        threads = [threading.Thread(target=worker, args=(w, c)) for w, c in enumerate(chunks) if c]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    n = {}
    for r in rows:
        n[r["verdict"]] = n.get(r["verdict"], 0) + 1
    print("TOTAL", json.dumps(n))


if __name__ == "__main__":
    main()
