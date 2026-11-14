"""CSP-safe helpers for the Playwright web regression tests.

The production page carries a strict CSP without ``unsafe-eval``
(``script-src 'self'`` in ``web/index.html``).  Playwright's
``wait_for_function`` with a *string* expression compiles that string in the
page's main world, which the CSP blocks.  The helpers below replace every
string-expression wait with either:

* a DOM marker the app sets after its module has finished —
  ``<body class="ink-app-ready">``, added at the very end of ``web/app.js``;
* a Python-side polling loop that reads a DOM attribute via
  ``page.evaluate`` (an arrow-function string evaluated over the CDP protocol,
  which does not trip the page CSP) — the app mirrors the document text onto
  ``body[data-ink-md]`` after every model commit.

``app_ready`` waits for the marker and lets the mobile viewport adapter's
``requestAnimationFrame`` batch settle.  ``markdown_settled`` and
``markdown_contains`` poll the mirror attribute until it matches.  ``load``
feeds the app through the native file input and then waits on the mirror.
"""
import time

# Re-exported so test files can ``from inktest import load`` without remembering
# the native file-input step.
__all__ = ["app_ready", "markdown_settled", "markdown_contains", "load"]

_READY = "body.ink-app-ready"


def app_ready(page, timeout=30000):
    """Block until the web app module has finished and the editor is live.

    The marker class is added at the end of ``web/app.js`` — the same point
    where ``window.inkstone`` is installed — so waiting on the DOM is
    equivalent to the old ``wait_for_function('Boolean(window.inkstone)')``
    without any string evaluation in the page.
    """
    page.wait_for_selector(_READY, state="attached", timeout=timeout)
    # One extra animation frame after the marker flips: the mobile adapter
    # batches its viewport work through requestAnimationFrame.
    page.wait_for_function(
        "() => new Promise((r) => requestAnimationFrame(() => r(true)))",
        timeout=5000,
    )


def _ink_md(page):
    """Read the document text the app mirrored onto ``body[data-ink-md]``.

    The mirror substitutes ``\\n`` with U+0001 so the attribute stays a single
    line; compare against that form, not the raw document text.
    """
    value = page.evaluate("() => document.body.dataset.inkMd || ''")
    return value.replace("\u0001", "\n")


def markdown_settled(page, expected, timeout=30000, interval=0.05):
    """Poll until the app's document text equals ``expected`` exactly.

    Replacement for ``wait_for_function("(v) => window.inkstone.getMarkdown()
    === v", arg=expected)``: the DOM mirror updates on every model commit, so
    reading it through CDP is safe under the strict CSP.
    """
    marker = expected.replace("\n", "\u0001").replace("\r\n", "\u0001")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw = page.evaluate("() => document.body.dataset.inkMd || ''")
        if raw == marker:
            return True
        time.sleep(interval)
    raise TimeoutError(f"markdown did not settle to {expected!r} within {timeout}s")


def markdown_contains(page, needle, timeout=30000, interval=0.05):
    """Poll until the app's document text contains ``needle``.

    Replacement for ``wait_for_function("window.inkstone.getMarkdown()
    .includes(...)")``: the substring check runs against the DOM mirror, not
    in the page.
    """
    # The mirror stores \n as \u0001, so convert the needle to match
    marker_needle = needle.replace("\n", "\u0001")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw = page.evaluate("() => document.body.dataset.inkMd || ''")
        if marker_needle in raw:
            return True
        time.sleep(interval)
    raise TimeoutError(f"markdown did not contain {needle!r} within {timeout}s")


def load(page, raw, name="测试.md", mime="text/markdown"):
    """Import ``raw`` through the native file input and wait until the open has run.

    ``markdown_settled`` alone is not enough: when the document already holds the
    same text, the mirror matches *before* the asynchronous open handler has run,
    so the helper can return while the app is still reading the file.  The late
    ``已打开`` toast then overwrites whatever toast the caller just asserted on —
    flaky on a loaded CI runner.  Clear the toast first and wait for the open to
    report itself, so callers always return after the open has been applied.
    """
    target = raw.replace("\r\n", "\n").replace("\r", "\n")
    marker = target.replace("\n", "\u0001")
    page.evaluate("() => { document.getElementById('toast').textContent = ''; }")
    page.locator("#file-input").set_input_files(
        {"name": name, "mimeType": mime, "buffer": raw.encode("utf-8")}
    )
    state = {}
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        state = page.evaluate(
            "() => ({ md: document.body.dataset.inkMd || '',"
            " toast: document.getElementById('toast').textContent })"
        )
        if state["md"] == marker and state["toast"].startswith("已打开"):
            return True
        time.sleep(0.05)
    raise TimeoutError(f"打开文件后文档未就绪：md={state.get('md')!r} toast={state.get('toast')!r}")
