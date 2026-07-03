#!/usr/bin/env python3
"""Machine-authored test verdict wrapper (sprint skill verify-execution contract).

Runs the project's declared verification commands (.claude/verify.json, or a
Makefile verify:/test: fallback), captures REAL process exit codes and optional
JUnit XML, and writes docs/sprint-logs/{SprintID}/verify-run.json.

The model NEVER edits verify-run.json or verify-run-*.log; test status in
verification-results.json is copied from this artifact. See
sprint/references/verify-execution.md and VERIFY_RUN_SCHEMA.json.

Exit codes: 0 = overall pass, 1 = overall fail, 2 = unconfigured (gap).
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET


def load_commands(root: str, sprint: str):
    cfg_path = os.path.join(root, ".claude", "verify.json")
    if os.path.exists(cfg_path):
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
        cmds = cfg.get("commands", [])
        if cmds:
            return cmds, "declared (.claude/verify.json)"
    makefile = os.path.join(root, "Makefile")
    if os.path.exists(makefile):
        with open(makefile, encoding="utf-8") as f:
            content = f.read()
        if re.search(r"^verify:", content, re.M):
            return [{"name": "verify", "command": "make verify"}], "fallback (make verify)"
        if re.search(r"^test:", content, re.M):
            return [{"name": "test", "command": "make test"}], "fallback (make test)"
    return None, None


def parse_junit(paths):
    total = passed = failed = errored = skipped = 0
    cases = []
    for p in paths:
        try:
            tree = ET.parse(p)
        except ET.ParseError:
            continue
        root = tree.getroot()
        for tc in root.iter("testcase"):
            total += 1
            classname = tc.get("classname", "")
            name = tc.get("name", "")
            full = f"{classname}.{name}" if classname else name
            if tc.find("failure") is not None:
                failed += 1
                cases.append({"name": full, "status": "fail"})
            elif tc.find("error") is not None:
                errored += 1
                cases.append({"name": full, "status": "error"})
            elif tc.find("skipped") is not None:
                skipped += 1
                cases.append({"name": full, "status": "skip"})
            else:
                passed += 1
                cases.append({"name": full, "status": "pass"})
    if total == 0:
        return None
    return {
        "total": total,
        "passed": passed,
        "failed": failed,
        "errored": errored,
        "skipped": skipped,
        "cases": cases,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sprint", required=True)
    args = ap.parse_args()

    root = os.getcwd()
    log_dir = os.path.join(root, "docs", "sprint-logs", args.sprint)
    os.makedirs(log_dir, exist_ok=True)

    # freshness: remove artifacts of previous runs
    for old in glob.glob(os.path.join(log_dir, "verify-run-*.log")):
        os.remove(old)
    out_path = os.path.join(log_dir, "verify-run.json")
    if os.path.exists(out_path):
        os.remove(out_path)

    commands, source = load_commands(root, args.sprint)
    if not commands:
        print("run-verify: no verify command configured (.claude/verify.json or Makefile verify:/test:)",
              file=sys.stderr)
        return 2

    runs = []
    overall = "pass"
    for cmd in commands:
        name = cmd["name"]
        command = cmd["command"]
        cwd = os.path.join(root, cmd["cwd"]) if cmd.get("cwd") else root
        log_path = os.path.join(log_dir, f"verify-run-{name}.log")
        with open(log_path, "w", encoding="utf-8") as logf:
            proc = subprocess.run(
                command, shell=True, cwd=cwd,
                stdout=logf, stderr=subprocess.STDOUT,
            )
            exit_code = proc.returncode
            logf.write(f"\n__VERIFY_EXIT_CODE__:{name}:{exit_code}\n")

        junit = None
        if cmd.get("junit_glob"):
            pattern = cmd["junit_glob"].replace("{SprintID}", args.sprint)
            junit = parse_junit(sorted(glob.glob(os.path.join(root, pattern))))

        status = "pass"
        if exit_code != 0:
            status = "fail"
        elif junit and (junit["failed"] > 0 or junit["errored"] > 0):
            status = "fail"
        if status == "fail":
            overall = "fail"

        runs.append({
            "name": name,
            "command": command,
            "exit_code": exit_code,
            "log": os.path.relpath(log_path, root),
            "machine_status": status,
            "junit": junit,
        })
        print(f"run-verify: {name}: exit={exit_code} status={status}")

    result = {
        "$machine_authored": True,
        "sprint": args.sprint,
        "command_source": source,
        "runs": runs,
        "overall_machine_status": overall,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"run-verify: overall={overall} -> {os.path.relpath(out_path, root)}")
    return 0 if overall == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
