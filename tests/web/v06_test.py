import base64
import json
import os
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get("INKSTONE_WEB_URL", "http://127.0.0.1:4173/")
RESULTS = ROOT / "test-results" / "web" / "v06-results.json"
RESULTS.parent.mkdir(parents=True, exist_ok=True)

# 1x1 transparent PNG shared by the route mock and the inline data URL.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)
DATA_URL = "data:image/png;base64," + base64.b64encode(PNG).decode()


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
        {"name": "v06.md", "mimeType": "text/markdown", "buffer": raw.encode("utf-8")}
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
        # --- placeholder markup, sanitizer boundary, local-image stance ---
        raw = f"# 山间笔记\n\n![小屋](house.png)\n\n<img src=\"https://img.example/pwn.png\" onerror=\"window.PWNED=1\">\n"
        load(page, raw)
        blur(page)
        assert page.locator("#editor .ink-image").count() == 1
        assert page.locator("#editor .ink-image").get_attribute("data-ink-src") == "house.png"
        assert page.locator("#editor .ink-image .ink-image-label").inner_text() == "小屋"
        assert page.locator("#editor img").count() == 0, "raw <img> must never reach the editor"
        assert not page.evaluate("Boolean(window.PWNED)")
        assert page.locator("#editor .ink-image .ink-image-note").inner_text().find("桌面版") >= 0
        assert markdown(page) == raw
        cases.append("图片渲染为占位卡片，原始 img 与 onerror 被剥离")
        print("PASS", cases[-1], flush=True)

        # --- remote images load only after the user clicks ---
        raw = "![远程](https://img.example/test.png)\n"
        load(page, raw)
        blur(page)
        hits = []
        page.route("https://img.example/test.png", lambda route: (hits.append(1), route.fulfill(body=PNG, content_type="image/png")))
        assert page.locator("#editor .ink-image-load").count() == 1
        page.wait_for_timeout(120)
        assert not hits, "no network request may happen before the user clicks"
        page.locator("#editor .ink-image-load").click()
        page.wait_for_selector("#editor .ink-image-ready img")
        assert page.evaluate("document.querySelector('#editor .ink-image-ready img').naturalWidth") == 1
        page.wait_for_timeout(120)
        assert len(hits) == 1, hits
        assert markdown(page) == raw
        cases.append("网络图片点击后才加载且不改动原文")
        print("PASS", cases[-1], flush=True)

        # --- data URLs mount immediately ---
        raw = f"![数据]({DATA_URL})\n"
        load(page, raw)
        blur(page)
        page.wait_for_selector("#editor .ink-image-ready img")
        assert page.evaluate("document.querySelector('#editor .ink-image-ready img').naturalWidth") == 1
        assert page.locator("#editor .ink-image-load").count() == 0
        cases.append("data URL 图片自动加载")
        print("PASS", cases[-1], flush=True)

        # --- export: offline single file with MathML, embedded data image, missing notes ---
        raw = (
            "# 山间笔记\n\n正文 $E = mc^2$ 与脚注[^1]。\n\n[^1]: 注释内容\n\n"
            f"![本地图](house.png)\n\n![数据图]({DATA_URL})\n\n![远程未加载](https://img.example/never.png)\n"
        )
        load(page, raw)
        blur(page)
        page.wait_for_selector("#editor .ink-image-ready img")
        with page.expect_download() as info:
            page.locator("#export-html").click()
        download = info.value
        assert download.suggested_filename == "山间笔记.html", download.suggested_filename
        exported = ROOT / "test-results" / "web" / "v06-export.html"
        download.save_as(exported)
        html = exported.read_text(encoding="utf-8")
        assert html.startswith("<!doctype html>"), html[:40]
        assert "<title>山间笔记</title>" in html
        assert "<math" in html, "formulas export as MathML"
        assert html.count("<img") == 1 and 'src="data:image/png;base64,' in html, "only the data image embeds"
        assert html.count('<span class="ink-export-missing">') == 2, "local and unloaded remote stay placeholders"
        assert 'id="ink-fn-1"' in html and "注释内容" in html
        assert "<script" not in html.lower()
        cases.append("导出 HTML 为离线单文件并按隐私立场内嵌图片")
        print("PASS", cases[-1], flush=True)

        # --- helper image probe must not break typing round-trips ---
        caret_doc = "![待加载](https://img.example/second.png)\n\n正文段落\n"
        load(page, caret_doc)
        caret(page, 2, 4)
        page.keyboard.type("!")
        assert markdown(page) == "![待加载](https://img.example/second.png)\n\n正文段落!\n", repr(markdown(page))
        cases.append("占位卡片不影响普通输入与光标映射")
        print("PASS", cases[-1], flush=True)
    finally:
        server and server.terminate()
        browser.close()

assert not errors, errors
RESULTS.write_text(json.dumps({"passed": len(cases), "cases": cases, "pageErrors": errors}, ensure_ascii=False, indent=2) + "\n")
print(f"ALL PASS: {len(cases)} cases", flush=True)
