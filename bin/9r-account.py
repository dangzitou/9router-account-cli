#!/usr/bin/env python3
"""Convenience wrapper for the 9router account importer.

This keeps the existing Node.js importer as the source of truth, but adds a
clipboard-friendly path so large JSON blobs do not have to be pasted directly
into the terminal.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
NODE_CLI = REPO_ROOT / "bin" / "9r-account.mjs"


def main() -> int:
    argv = sys.argv[1:]
    if not argv or argv[0] == "help" or any(flag in argv for flag in ("-h", "--help")):
        print_help()
        return 0

    if not NODE_CLI.exists():
        print(f"Error: {NODE_CLI} not found.", file=sys.stderr)
        return 1

    clipboard = "--clipboard" in argv
    argv = [arg for arg in argv if arg != "--clipboard"]
    command = argv[0]

    if clipboard and command != "import":
        print("Error: --clipboard can only be used with the import command.", file=sys.stderr)
        return 1

    if clipboard:
        try:
            payload = read_clipboard()
        except RuntimeError as error:
            print(f"Error: {error}", file=sys.stderr)
            return 1
        payload = strip_code_fence(payload)
        if not payload.strip():
            print("Error: clipboard does not contain usable JSON.", file=sys.stderr)
            return 1
        temp_path = write_temp_payload(payload)
        try:
            return run_node(["import", temp_path, *clipboard_passthrough(argv[1:])])
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass

    return run_node(argv)


def print_help() -> None:
    print(
        """Usage:
  9r-account import --clipboard [options]
  9r-account import ./account.json [options]
  9r-account list [options]
  9r-account detect [options]

Options:
  --clipboard    Read JSON from the system clipboard and pipe it to the Node importer.

Examples:
  9r-account import --clipboard --activate --clear-proxy
  9r-account import ./account.json
  9r-account list --provider codex
"""
    )


def run_node(extra_args: list[str]) -> int:
    cmd = ["node", str(NODE_CLI), *extra_args]
    result = subprocess.run(cmd, text=True)
    return result.returncode


def read_clipboard() -> str:
    env_text = os.environ.get("9R_ACCOUNT_CLIPBOARD_TEXT")
    if env_text is not None:
        return env_text

    for candidate in (
        ["pbpaste"],
        ["xclip", "-selection", "clipboard", "-o"],
        ["xsel", "--clipboard", "--output"],
    ):
        if shutil.which(candidate[0]) is None:
            continue
        try:
            result = subprocess.run(candidate, check=True, capture_output=True, text=True)
            return result.stdout
        except subprocess.CalledProcessError:
            continue

    raise RuntimeError(
        "No clipboard helper found. Use `pbpaste`, `xclip`, or `xsel`, or pass a file to the Node importer."
    )


def write_temp_payload(payload: str) -> Path:
    handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".json")
    try:
        handle.write(payload)
        handle.flush()
    finally:
        handle.close()
    return Path(handle.name)


def clipboard_passthrough(args: list[str]) -> list[str]:
    if args and not args[0].startswith("-"):
        return args[1:]
    return args


def strip_code_fence(text: str) -> str:
    lines = text.strip().splitlines()
    if len(lines) >= 2 and lines[0].strip().startswith("```") and lines[-1].strip() == "```":
        lines = lines[1:-1]
    return "\n".join(lines).strip()


if __name__ == "__main__":
    raise SystemExit(main())
