import base64
import json
import os
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get("INKSTONE_WEB_URL", "http://127.0.0.1:4173/")
RESULTS = ROOT / "test-results" / "web" / "v07-results.json"
RESULTS.parent.mkdir(parents=True, exist_ok=True)

# 1x1 transparent PNG pasted from the synthetic clipboard; the oversized sample is
# padding after the same header so the MIME type stays plausible.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)
BIG_PNG = PNG + b"\0" * (2 * 1024 * 1024 + 1)


def wait_server():
    try:
        import urllib.request
        urllib.request.urlopen(URL, timeout=1).read(32)
        return None
    except Exception:
        return subprocess.Popen(
            [sys.executable, "-m", "http.server", "4173", "--bind", "127.0.0.1", "--directory", "web"],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def boot(page):
    page.goto(URL)
    page.wait_for_function("Boolean(window.inkstone)")
    page.evaluate("localStorage.clear()")
    page.reload()
    page.wait_for_function("Boolean(window.inkstone)")


def load(page, raw):
    page.locator("#file-input").set_input_files(
        {"name": "v07.md", "mimeType": "text/markdown", "buffer": raw.encode("utf-8")}
    )
    page.wait_for_function("(value) => window.inkstone.getMarkdown() === value", arg=raw)


def markdown(page):
    return page.evaluate("window.inkstone.getMarkdown()")


def blur(page):
    page.locator("#status").click()
    page.wait_for_timeout(60)


def caret(page, index=0, offset=None):
    page.evaluate(
        """({ index, offset }) => {
          const editor = document.getElementById('editor');
          const el = editor.children[index];
          editor.focus();
          el.classList.add('active');
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const nodes = [];
          let node;
          while ((node = walker.nextNode())) nodes.push(node);
          let left = offset === null ? el.textContent.length : offset;
          let target = el;
          let off = 0;
          for (const candidate of nodes) {
            if (left <= candidate.length) { target = candidate; off = left; break; }
            left -= candidate.length;
          }
          const selection = getSelection();
          selection.setBaseAndExtent(target, off, target, off);
        }""",
        {"index": index, "offset": offset},
    )
    page.wait_for_timeout(30)


def paste_png(page, payload):
    page.evaluate(
        """({ bytes }) => {
          const bin = atob(bytes);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          const file = new File([arr], 'shot.png', { type: 'image/png' });
          const dt = new DataTransfer();
          dt.items.add(file);
          const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(ev, 'clipboardData', { value: dt });
          document.getElementById('editor').dispatchEvent(ev);
        }""",
        {"bytes": payload},
    )


cases = []
server = wait_server()
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=os.environ.get("CHROMIUM_PATH"),
        args=["--no-sandbox"],
    )
    page = browser.new_page(viewport={"width": 1440, "height": 1040}, accept_downloads=True)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())
    boot(page)
    try:
        # --- pasting a screenshot embeds a data URL and is undoable ---
        raw = "# 剪贴板\n\n开头段落\n"
        load(page, raw)
        caret(page, 2, None)
        paste_png(page, base64.b64encode(PNG).decode())
        page.wait_for_function("window.inkstone.getMarkdown().includes('![粘贴图片](data:image/png;base64,')")
        assert markdown(page).startswith("# 剪贴板\n\n开头段落![粘贴图片](data:image/png;base64,")
        page.keyboard.press("Control+z")
        assert markdown(page) == raw, "inserting a pasted image must be undoable"
        cases.append("网页粘贴截图以 data URL 内嵌且可撤销")
        print("PASS", cases[-1], flush=True)

        # --- oversized screenshots are rejected with a visible note ---
        load(page, raw)
        caret(page, 2, None)
        paste_png(page, base64.b64encode(BIG_PNG).decode())
        page.wait_for_timeout(250)
        assert "图片超过 2 MB" in page.locator("#toast").inner_text(), page.locator("#toast").inner_text()
        assert markdown(page) == raw, "rejected paste must not touch the document"
        cases.append("超过 2 MB 的截图被拒绝且原文不变")
        print("PASS", cases[-1], flush=True)

        # --- pasted data URLs render through the same image pipeline ---
        load(page, "# 导出\n\n正文 $a^2$。\n")
        caret(page, 2, None)
        paste_png(page, base64.b64encode(PNG).decode())
        page.wait_for_function("window.inkstone.getMarkdown().includes('data:image/png;base64,')")
        blur(page)
        page.wait_for_selector("#editor .ink-image-ready img")
        assert page.evaluate("document.querySelector('#editor .ink-image-ready img').naturalWidth") == 1
        cases.append("粘贴的 data URL 图片走既有渲染管线直接显示")
        print("PASS", cases[-1], flush=True)
    finally:
        server and server.terminate()
        browser.close()

assert not errors, errors
RESULTS.write_text(json.dumps({"passed": len(cases), "cases": cases, "pageErrors": errors}, ensure_ascii=False, indent=2) + "\n")
print(f"ALL PASS: {len(cases)} cases", flush=True)
