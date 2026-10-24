from pathlib import Path
import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get("INKSTONE_WEB_URL", "http://127.0.0.1:4173/")
RESULTS = ROOT / "test-results" / "web" / "v04-results.json"
RESULTS.parent.mkdir(parents=True, exist_ok=True)


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
        {"name": "v04.md", "mimeType": "text/markdown", "buffer": raw.encode("utf-8")}
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
    page = browser.new_page(viewport={"width": 1440, "height": 1040})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())
    boot(page)
    try:
        raw = "```js\nconst answer = 42;\n```\n"
        load(page, raw)
        blur(page)
        code = page.locator("#editor .code")
        assert code.count() == 1
        assert code.locator(".block-preview pre code .hljs-keyword").count() >= 1
        assert code.locator(".block-preview pre code .hljs-number").count() >= 1
        assert code.locator(".block-source").is_hidden()
        assert markdown(page) == raw
        cases.append("围栏代码非激活态高亮")
        print("PASS", cases[-1], flush=True)

        code.locator(".block-preview").click()
        assert code.locator(".block-source").is_visible()
        assert code.locator(".block-preview").is_hidden()
        caret(page, 0, len("```js\nconst answer = 42;"))
        page.keyboard.press("Enter")
        page.keyboard.insert_text("let extra = 7;")
        assert code.locator(".block-preview .hljs-keyword").count() == 0
        blur(page)
        assert code.locator(".block-preview .hljs-keyword").count() >= 1
        assert markdown(page).startswith("```js\nconst answer = 42;\nlet extra = 7;")
        cases.append("激活态编辑跳过高亮，失焦后补渲染")
        print("PASS", cases[-1], flush=True)

        raw = "```unknown\nplain <tag>\n```\n"
        load(page, raw)
        blur(page)
        assert page.locator("#editor .code .hljs-keyword").count() == 0
        assert "plain <tag>" in page.locator("#editor .code .block-preview").inner_text()
        assert markdown(page) == raw
        cases.append("未知语言回退纯文本")
        print("PASS", cases[-1], flush=True)

        raw = "```js\n" + "a" * 100001 + "\n```\n"
        load(page, raw)
        blur(page)
        assert page.locator("#editor .code .hljs-keyword").count() == 0
        assert markdown(page) == raw
        cases.append("超长代码回退纯文本")
        print("PASS", cases[-1], flush=True)

        raw = '```html\n</code><img src=x onerror="window.BAD=1"><script>window.BAD=2</script>\n```\n'
        load(page, raw)
        blur(page)
        assert not page.evaluate("Boolean(window.BAD)")
        assert page.locator("#editor .block-preview img, #editor .block-preview script").count() == 0
        assert markdown(page) == raw
        cases.append("代码内容 XSS 防护")
        print("PASS", cases[-1], flush=True)

        page.set_viewport_size({"width": 393, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.locator("#theme-toggle").click()
        assert page.locator("html").get_attribute("data-theme") == "dark"
        cases.append("移动端无横向溢出与深色主题")
        print("PASS", cases[-1], flush=True)

        assert not errors, errors
    finally:
        browser.close()
        if server:
            server.terminate()
            server.wait(timeout=5)

RESULTS.write_text(
    json.dumps({"passed": len(cases), "cases": cases, "pageErrors": errors}, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
print("ALL PASS", len(cases), flush=True)
