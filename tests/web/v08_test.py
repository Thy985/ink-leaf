import base64
import json
import os
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get("INKSTONE_WEB_URL", "http://127.0.0.1:4173/")
RESULTS = ROOT / "test-results" / "web" / "v08-results.json"
RESULTS.parent.mkdir(parents=True, exist_ok=True)

# 1x1 transparent PNG reused for every synthetic clipboard/drag payload.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


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
        {"name": "v08.md", "mimeType": "text/markdown", "buffer": raw.encode("utf-8")}
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


def paste_files(page, payloads, target="#editor"):
    page.evaluate(
        """({ bytes, target }) => {
          const dt = new DataTransfer();
          for (const payload of bytes) {
            const bin = atob(payload);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            dt.items.add(new File([arr], 'shot.png', { type: 'image/png' }));
          }
          const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(ev, 'clipboardData', { value: dt });
          document.querySelector(target).dispatchEvent(ev);
        }""",
        {"bytes": payloads, "target": target},
    )


def drag_files(page, kind, target):
    """Dispatch a synthetic drag event with a Files payload; returns event.defaultPrevented."""
    return page.evaluate(
        """({ kind, target }) => {
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array([137, 80])], 'shot.png', { type: 'image/png' }));
          const ev = new DragEvent(kind, { bubbles: true, cancelable: true });
          Object.defineProperty(ev, 'dataTransfer', { value: dt });
          document.querySelector(target).dispatchEvent(ev);
          return ev.defaultPrevented;
        }""",
        {"kind": kind, "target": target},
    )


def composition(page, phase):
    page.evaluate(
        """(phase) => {
          document.getElementById('editor').dispatchEvent(new CompositionEvent(phase, { bubbles: true }));
        }""",
        phase,
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
        # --- every image in one paste is inserted, separated by blank lines ---
        raw = "# 多图\n\n段落\n"
        load(page, raw)
        caret(page, 2, None)
        paste_files(page, [base64.b64encode(PNG).decode(), base64.b64encode(PNG).decode()])
        page.wait_for_function(
            "(window.inkstone.getMarkdown().match(/!\\[粘贴图片\\]\\(data:image\\/png;base64,/g) || []).length === 2"
        )
        md = markdown(page)
        assert "\n\n![粘贴图片](" in md, md
        blur(page)
        assert page.locator("#editor .ink-image-ready img").count() == 2
        cases.append("一次粘贴多张截图全部插入并渲染")
        print("PASS", cases[-1], flush=True)

        load(page, raw)
        caret(page, 2, None)
        paste_files(page, [base64.b64encode(PNG).decode(), base64.b64encode(PNG).decode()])
        page.wait_for_function(
            "(window.inkstone.getMarkdown().match(/!\\[粘贴图片\\]\\(data:image\\/png;base64,/g) || []).length === 2"
        )
        page.keyboard.press("Control+z")
        assert markdown(page) == raw, "a batch paste must undo as one step"
        cases.append("多图粘贴作为一步整体撤销")
        print("PASS", cases[-1], flush=True)

        # --- IME composing blocks image paste; composition end restores it ---
        load(page, raw)
        caret(page, 2, None)
        composition(page, "compositionstart")
        paste_files(page, [base64.b64encode(PNG).decode()])
        page.wait_for_timeout(200)
        assert "![粘贴图片]" not in markdown(page), "paste must be ignored during composition"
        composition(page, "compositionend")
        page.wait_for_timeout(100)
        paste_files(page, [base64.b64encode(PNG).decode()])
        page.wait_for_function("window.inkstone.getMarkdown().includes('data:image/png;base64,')")
        page.keyboard.press("Control+z")
        assert markdown(page) == raw, "document must survive the composing round-trip"
        cases.append("组合输入中粘贴被忽略，组合结束恢复正常")
        print("PASS", cases[-1], flush=True)

        # --- file drags outside the editor are claimed so the page is never replaced ---
        load(page, raw)
        assert drag_files(page, "dragover", "body"), "window dragover must preventDefault Files drags"
        prevented = drag_files(page, "drop", "body")
        page.wait_for_timeout(150)
        assert prevented, "window drop must preventDefault Files drops"
        assert "拖到编辑器内" in page.locator("#toast").inner_text(), page.locator("#toast").inner_text()
        assert markdown(page) == raw
        cases.append("编辑器外拖入文件被兜底拦截并有引导提示")
        print("PASS", cases[-1], flush=True)

        # --- dropping an image inside the editor still inserts and skips the guard ---
        load(page, raw)
        caret(page, 2, None)
        assert drag_files(page, "drop", "#editor")
        page.wait_for_function("window.inkstone.getMarkdown().includes('data:image/png;base64,')")
        page.wait_for_timeout(150)
        assert "已插入" in page.locator("#toast").inner_text(), page.locator("#toast").inner_text()
        assert "拖到编辑器内" not in page.locator("#toast").inner_text()
        page.keyboard.press("Control+z")
        assert markdown(page) == raw
        cases.append("编辑器内拖放图片正常插入且不触发兜底提示")
        print("PASS", cases[-1], flush=True)
    finally:
        server and server.terminate()
        browser.close()

assert not errors, errors
RESULTS.write_text(json.dumps({"passed": len(cases), "cases": cases, "pageErrors": errors}, ensure_ascii=False, indent=2) + "\n")
print(f"ALL PASS: {len(cases)} cases", flush=True)
