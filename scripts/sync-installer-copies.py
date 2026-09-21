#!/usr/bin/env python3
"""Regenerate setup_hub.py's embedded copies of this repo's real files.

WHY THIS EXISTS
---------------
setup_hub.py scaffolds a fresh hub by writing out files whose contents it
carries inline, as Python string literals. ci.yml guards that by running
the installer into a scratch directory and diffing every generated file
against the real one, so a fresh install can't silently drift from what
this repo actually runs.

The guard works. What it lacked was a way to *satisfy* it. Fixing a drift
meant hand-editing a string literal inside a 2400-line Python file, which
is fine for a human who knows that's the deal and impossible for a bot
that doesn't. Dependabot edits package.json or a workflow, never sees the
embedded copy, and fails the diff — so every dependency PR touching one
of these files was unmergeable until someone hand-synced it. Four sat red
at once before this script existed.

    python3 scripts/sync-installer-copies.py           # fix the drift
    python3 scripts/sync-installer-copies.py --check   # report, change nothing
    python3 scripts/sync-installer-copies.py --list    # the tracked paths
    python3 scripts/sync-installer-copies.py --self-test

THE HAZARD, AND WHY THIS IS SAFE ANYWAY
---------------------------------------
The embedded literals are ordinary triple-quoted Python strings, not raw
ones, so a backslash in the source file means something else once it's
inside one. api/autonomous_agent.js alone contains 13 `\\n` sequences
written as two characters in JavaScript; embed those verbatim and Python
turns each into a real newline, and the installer writes a file that
differs from the original in a way nobody reads a diff closely enough to
catch. A `\"\"\"` in the content, or a trailing quote or backslash, breaks
the literal outright or silently swallows the delimiter.

Rather than trust the escaping rules, every literal this script produces
is parsed back with ast.literal_eval and compared to the exact bytes it
came from, before anything is written. A literal that doesn't round-trip
is never spliced — the script raises instead. That turns "did I get the
escaping right" from a question into an invariant: this script can refuse
to run, but it cannot quietly corrupt the installer.

A useful consequence, found by deliberately sabotaging make_literal to
confirm the tests actually catch it: with the escaping removed but the
round-trip check intact, the triple-quoted candidate simply fails
verification and the repr() fallback takes over. Output stays correct;
only readability suffers. Corruption needs BOTH the escaping and the
verification to be wrong. Keep the verification even if the escaping
rules here are later replaced with something cleverer.

WHAT IS AND ISN'T SYNCED
------------------------
Only TRACKED_PATHS below. setup_hub.py also seeds spokes.json,
tenants.json, universal_lessons.md and north_star_framework.md, which are
deliberately fresh-install defaults rather than mirrors of this repo's
own accumulated state — syncing those would ship this hub's live spoke
registry to every new install. ci.yml's own diff skips them for the same
reason, and ci.yml gets its list from this script's --list so the two
can't drift apart.
"""

import argparse
import ast
import io
import os
import sys

# The files setup_hub.py embeds AND must keep identical to the real thing.
# ci.yml reads this list via --list; it is the single source of truth.
TRACKED_PATHS = [
    "api/autonomous_agent.js",
    "api/recursive_learning.js",
    "scripts/prune-logs.js",
    "scripts/health-report.js",
    "scripts/collect-issue-feedback.js",
    "scripts/doctor.js",
    ".github/workflows/self-reflect.yml",
    ".github/workflows/prune-logs.yml",
    ".github/workflows/health-report.yml",
    ".github/workflows/recursive-learning.yml",
    ".github/workflows/collect-issue-feedback.yml",
    ".github/workflows/doctor.yml",
    "package.json",
    ".gitignore",
]

INSTALLER = "setup_hub.py"


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ── Literal construction ─────────────────────────────────────────


def make_literal(content):
    """Return Python source for a string literal equal to `content`.

    Prefers a triple-quoted literal, because that is the shape
    setup_hub.py already uses and the one that stays readable in a diff.
    Falls back to repr() for content a triple-quote can't carry
    faithfully. Either way the result is verified, not assumed.
    """
    candidates = []

    body = content.replace("\\", "\\\\").replace('"""', '\\"\\"\\"')
    # A trailing quote would run into the closing delimiter and make
    # `""""`; escaping it keeps the delimiter unambiguous.
    if body.endswith('"'):
        body = body[:-1] + '\\"'
    candidates.append('"""' + body + '"""')

    # Always available, always correct, just unreadable for a large file.
    candidates.append(repr(content))

    for literal in candidates:
        if literal_round_trips(literal, content):
            return literal

    raise AssertionError(
        "no literal form round-tripped for content of %d chars — refusing to "
        "write a literal that does not reproduce its source exactly"
        % len(content)
    )


def literal_round_trips(literal, content):
    """True only if `literal` parses back to exactly `content`."""
    try:
        return ast.literal_eval(literal) == content
    except (ValueError, SyntaxError, MemoryError, RecursionError):
        return False


def embedded_form(content):
    """What setup_hub.py should carry for a file with these contents.

    setup_hub.py's literals never end in a newline while the real files
    do; ci.yml's `norm()` normalizes that away on both sides, so it is an
    accepted cosmetic difference rather than drift. Matching it here
    keeps this script a no-op on an already-synced tree.
    """
    return content.rstrip("\n")


# ── Locating the embedded copies ─────────────────────────────────


def find_entries(source):
    """Map each embedded path to its content literal's (start, end) offsets.

    Uses the AST for position, then splices the raw source by offset, so
    every comment, blank line and bit of formatting in setup_hub.py
    survives untouched. Rewriting from the AST would flatten all of it.
    """
    lines = source.splitlines(keepends=True)
    starts, acc = [], 0
    for line in lines:
        starts.append(acc)
        acc += len(line)

    def offset(lineno, col):
        return starts[lineno - 1] + col

    found = {}
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Dict):
            continue
        path_value, content_node = None, None
        for key, value in zip(node.keys, node.values):
            if not isinstance(key, ast.Constant):
                continue
            if key.value == "path" and isinstance(value, ast.Constant):
                path_value = value.value
            elif key.value == "content":
                content_node = value
        if path_value is None or content_node is None:
            continue
        if not isinstance(content_node, ast.Constant) or not isinstance(
            content_node.value, str
        ):
            continue
        found[path_value] = (
            offset(content_node.lineno, content_node.col_offset),
            offset(content_node.end_lineno, content_node.end_col_offset),
            content_node.value,
        )
    return found


def plan_edits(root):
    """Compute what needs changing. Returns (edits, drifted_paths)."""
    installer_path = os.path.join(root, INSTALLER)
    source = io.open(installer_path, encoding="utf-8").read()
    entries = find_entries(source)

    missing = [p for p in TRACKED_PATHS if p not in entries]
    if missing:
        raise SystemExit(
            "%s has no embedded copy of: %s\n"
            "Either add one, or drop the path from TRACKED_PATHS in %s."
            % (INSTALLER, ", ".join(missing), __file__)
        )

    edits, drifted = [], []
    for path in TRACKED_PATHS:
        start, end, current = entries[path]
        real = io.open(os.path.join(root, path), encoding="utf-8").read()
        wanted = embedded_form(real)
        if current == wanted:
            continue
        drifted.append(path)
        edits.append((start, end, make_literal(wanted), path))
    return source, edits, drifted


def apply_edits(source, edits):
    # Back to front, so each splice leaves earlier offsets valid.
    for start, end, literal, _path in sorted(edits, reverse=True):
        source = source[:start] + literal + source[end:]
    return source


# ── Verification ─────────────────────────────────────────────────


def verify(root, source):
    """Parse the rewritten installer and confirm every tracked copy matches.

    Belt and braces over make_literal's own round-trip check: this reads
    the result back out of the finished file, the way ci.yml eventually
    will, rather than trusting the in-memory value.
    """
    entries = find_entries(source)
    for path in TRACKED_PATHS:
        real = io.open(os.path.join(root, path), encoding="utf-8").read()
        if entries[path][2] != embedded_form(real):
            raise AssertionError(
                "post-write verification failed for %s — the embedded copy "
                "does not match the real file" % path
            )


# ── Self-test ────────────────────────────────────────────────────

ADVERSARIAL = [
    ("plain", "hello world"),
    ("empty", ""),
    ("backslash-n as two chars", r"const s = 'a\nb';"),
    ("backslash-backslash", r"path = 'C:\\tmp\\x'"),
    ("real newlines", "line one\nline two\n"),
    ("trailing backslash", "continued \\"),
    ("trailing quote", 'he said "hi"'),
    ("triple quote inside", 'doc = """nested""" end'),
    ("triple quote at end", 'ends with """'),
    ("quote then backslash", "mixed \"\\"),
    ("yaml line continuation", 'curl -X POST "$URL" \\\n  -H "A: b" \\\n  -d "{}"'),
    ("tab and cr", "a\tb\r\nc"),
    ("unicode", "caf\u00e9 \u2014 na\u00efve \U0001f600"),
    ("lone quote char", '"'),
    ("just backslash", "\\"),
    ("nul-adjacent escapes", r"\t\r\0\x41\u1234"),
]


def self_test():
    failures = []
    for name, content in ADVERSARIAL:
        try:
            literal = make_literal(content)
        except AssertionError as err:
            failures.append("%s: make_literal raised: %s" % (name, err))
            continue
        try:
            got = ast.literal_eval(literal)
        except Exception as err:  # noqa: BLE001 - reporting, not handling
            failures.append("%s: literal does not parse: %s" % (name, err))
            continue
        if got != content:
            failures.append(
                "%s: round-trip mismatch\n    in:  %r\n    out: %r" % (name, content, got)
            )

    # A literal that does not round-trip must be rejected, not written.
    if literal_round_trips('"""a"""', "b"):
        failures.append("literal_round_trips accepted a mismatched literal")

    # The whole point: naive embedding of a JS \n must NOT survive, and
    # make_literal must be the thing that saves it.
    js = r"row.join('\n')"
    if ast.literal_eval('"""' + js + '"""') == js:
        failures.append(
            "expected naive triple-quoting to corrupt a JS backslash-n; it did not, "
            "so this test no longer proves make_literal is doing anything"
        )
    if ast.literal_eval(make_literal(js)) != js:
        failures.append("make_literal failed on the exact hazard it exists for")

    for failure in failures:
        print("FAIL " + failure)
    print(
        "%d/%d self-test cases passed"
        % (len(ADVERSARIAL) + 3 - len(failures), len(ADVERSARIAL) + 3)
    )
    return 1 if failures else 0


# ── Entry point ──────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="report drift and exit 1 without writing anything",
    )
    parser.add_argument(
        "--list", action="store_true", help="print the tracked paths, one per line"
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="exercise the escaping round-trip against adversarial content",
    )
    args = parser.parse_args()

    if args.list:
        print("\n".join(TRACKED_PATHS))
        return 0
    if args.self_test:
        return self_test()

    root = repo_root()
    source, edits, drifted = plan_edits(root)

    if not drifted:
        print("setup_hub.py is in sync with all %d tracked files." % len(TRACKED_PATHS))
        return 0

    if args.check:
        print("setup_hub.py has drifted from %d file(s):" % len(drifted))
        for path in drifted:
            print("  " + path)
        print("\nRun: python3 scripts/sync-installer-copies.py")
        return 1

    updated = apply_edits(source, edits)
    # Must still be valid Python before it is allowed to land.
    compile(updated, INSTALLER, "exec")
    verify(root, updated)
    io.open(os.path.join(root, INSTALLER), "w", encoding="utf-8").write(updated)

    print("Synced %d file(s) into setup_hub.py:" % len(drifted))
    for path in drifted:
        print("  " + path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
