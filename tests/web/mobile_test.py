"""移动 Web 回归测试；使用合成输入事件，不声称覆盖真实设备输入法。"""
from pathlib import Path
import json
import os
import subprocess
import time

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

URL = os.environ.get("INKSTONE_WEB_URL", "http://127.0.0.1:4173/")
ROOT = Path(__file__).resolve().parents[2] / "test-results" / "web"
ROOT.mkdir(parents=True, exist_ok=True)


def wait_server():
    try:
        import urllib.request
        urllib.request.urlopen(URL, timeout=1).read(32)
        return None
    except Exception:
        # The repository's web directory is already the built app root.
        return subprocess.Popen(
            ["python3", "-m", "http.server", "4173", "--bind", "127.0.0.1", "--directory", "web"],
            cwd=Path(__file__).resolve().parents[2],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def boot(page, width=393, height=844):
    page.set_viewport_size({"width": width, "height": height})
    page.goto(URL)
    page.wait_for_function("Boolean(window.inkstone)")
    page.evaluate("localStorage.clear()")
    page.reload()
    page.wait_for_function("Boolean(window.inkstone)")


def markdown(page):
    return page.evaluate("window.inkstone.getMarkdown()")


def source_set(page, value):
    if not page.locator("#source").is_visible():
        page.locator("#source-toggle").click()
    page.locator("#source").fill(value)
    page.wait_for_function("(v) => window.inkstone.getMarkdown() === v", arg=value)


def wait_native_request(page, count=1):
    page.wait_for_function("(n) => window.__nativeRequests.length >= n", arg=count)
    return page.evaluate("window.__nativeRequests[window.__nativeRequests.length - 1]")


def native_result(page, detail):
    page.evaluate("""(detail) => window.dispatchEvent(new CustomEvent(
        'inkleaf-native-result', { detail }))""", detail)


def assert_no_horizontal_overflow(page, width, height):
    page.set_viewport_size({"width": width, "height": height})
    page.wait_for_timeout(80)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), (width, page.evaluate("document.documentElement.scrollWidth"))


def run():
    server = wait_server()
    cases = []
    errors = []

    def passed(name):
        cases.append(name)
        print("PASS", name, flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path=os.environ.get("CHROMIUM_PATH"),
            args=["--no-sandbox"],
        )

        # Ordinary mobile Web: file input and Blob download are browser paths.
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        boot(page)

        for width in (320, 360, 393, 412):
            assert_no_horizontal_overflow(page, width, 844)
        # Also exercise the narrow landscape/tablet-like viewport.
        assert_no_horizontal_overflow(page, 844, 412)
        passed("320/360/393/412 与横屏视口无 document 水平溢出")

        page.set_viewport_size({"width": 393, "height": 844})
        for selector in ("#open", "#save"):
            box = page.locator(selector).bounding_box()
            assert box and box["height"] >= 44, (selector, box)
        for selector in (".toolbar button", "#outline button"):
            if page.locator(selector).count():
                for i in range(page.locator(selector).count()):
                    box = page.locator(selector).nth(i).bounding_box()
                    if box is not None:
                        assert box["height"] >= 44, (selector, i, box)
        passed("主要文件/格式/大纲触控目标至少 44px")

        source_set(page, "# 第一章\n\n## 第二章\n\n正文")
        page.locator("#sidebar-toggle").click()
        assert page.locator("body").evaluate("e => e.classList.contains('mobile-outline')")
        assert page.locator("#outline-scrim").is_visible()
        for i in range(page.locator("#outline button").count()):
            box = page.locator("#outline button").nth(i).bounding_box()
            assert box and box["height"] >= 44, ("#outline button", i, box)
        page.locator("#outline button").first.click()
        assert not page.locator("body").evaluate("e => e.classList.contains('mobile-outline')")
        page.locator("#sidebar-toggle").click()
        page.locator("#outline-scrim").click(position={"x": 380, "y": 400})
        assert not page.locator("body").evaluate("e => e.classList.contains('mobile-outline')")
        passed("大纲打开、选项关闭与遮罩关闭")

        # Web file input normalizes UTF-8 BOM and CRLF and replaces the draft only on success.
        source_set(page, "原草稿")
        page.locator("#file-input").set_input_files({
            "name": "导入.md", "mimeType": "text/markdown",
            "buffer": b"\xef\xbb\xbf" + "# 标题\r\n\r\n正文\r\n".encode("utf-8"),
        })
        page.wait_for_function("window.inkstone.getMarkdown() === '# 标题\\n\\n正文\\n'")
        assert page.locator("#filename").inner_text() == "导入.md"
        passed("移动 Web file input 导入 UTF-8 BOM 与 CRLF")

        source_set(page, "导出内容\n")
        with page.expect_download() as download_info:
            page.locator("#save").click()
        download = download_info.value
        exported = ROOT / "mobile-blob-export.md"
        download.save_as(exported)
        assert exported.read_text(encoding="utf-8") == "导出内容\n"
        exported.unlink()
        assert page.locator("#dirty").inner_text() == ""
        passed("移动 Web Blob 导出内容与 dirty 状态")

        # Synthetic composition checks: these are event-contract tests, not a real IME test.
        source_set(page, "源码")
        page.evaluate("""() => {
          window.__sourceInputs = 0;
          source.addEventListener('input', () => window.__sourceInputs++);
        }""")
        during = page.evaluate("""() => {
          const s = document.getElementById('source');
          s.focus(); s.setSelectionRange(s.value.length, s.value.length);
          s.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true, data: ''}));
          s.value = '源码中';
          s.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertCompositionText', data: '中', isComposing: true}));
          return {model: window.inkstone.getMarkdown(), composing: window.inkstone.isComposing};
        }""")
        assert during == {"model": "源码", "composing": True}, during
        page.evaluate("""() => {
          const s = document.getElementById('source');
          s.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: '中'}));
          s.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: '中', isComposing: false}));
        }""")
        page.wait_for_timeout(30)
        assert markdown(page) == "源码中"
        assert page.evaluate("window.__sourceInputs") in (2, 3)  # native final input plus optional app fallback; model must commit once
        passed("源码模式 compositionstart/update/end：中途不 commit、最终 input 不重复")

        source_set(page, "富文本")
        page.locator("#source-toggle").click()
        page.evaluate("""() => {
          const e = document.getElementById('editor');
          window.__richInputs = 0;
          e.addEventListener('input', () => window.__richInputs++);
          e.focus();
          const n = e.firstChild.firstChild || e.firstChild;
          const end = n.textContent.length;
          getSelection().setBaseAndExtent(n, end, n, end);
          e.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true, data: ''}));
          n.textContent += '中';
          e.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertCompositionText', data: '中', isComposing: true}));
          e.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: '中'}));
          e.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: '中', isComposing: false}));
        }""")
        page.wait_for_timeout(30)
        assert markdown(page) == "富文本中"
        assert page.evaluate("window.__richInputs") == 2
        passed("富文本 composition 与最终 input 同样只产生一次模型提交")

        # Flush both lifecycle paths synchronously, including the composition DOM path.
        source_set(page, "立即落盘")
        page.evaluate("""() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('pagehide'));
        }""")
        stored = page.evaluate("JSON.parse(localStorage.getItem('inkstone.draft.v03'))")
        assert stored["text"] == "立即落盘"
        passed("visibilitychange/pagehide 立即 flush 本地草稿")
        context.close()

        # Android bridge simulation is installed before app.js through add_init_script.
        android = browser.new_context()
        android.add_init_script("""(() => {
          window.__nativeRequests = [];
          window.InkLeafAndroid = { postMessage(message) {
            window.__nativeRequests.push(JSON.parse(message));
          }};
        })()""")
        native = android.new_page()
        native.on("pageerror", lambda e: errors.append(str(e)))
        native.on("dialog", lambda d: d.accept())
        boot(native)
        assert native.locator("#save").inner_text() == "导出 .md"
        source_set(native, "原始草稿")

        native.locator("#open").click()
        request = wait_native_request(native)
        assert set(request) == {"id", "action", "filename", "text"}
        assert request["action"] == "open" and request["text"] == "原始草稿"
        native_result(native, {"id": request["id"], "canceled": True})
        native.wait_for_timeout(20)
        assert markdown(native) == "原始草稿" and native.locator("#dirty").inner_text() == "•"

        native.locator("#open").click()
        request = wait_native_request(native, 2)
        native_result(native, {"id": request["id"], "error": "读取失败"})
        native.wait_for_timeout(20)
        assert markdown(native) == "原始草稿" and native.locator("#dirty").inner_text() == "•"
        passed("Android 导入取消/失败不替换 dirty 草稿")

        # Export sends a snapshot; edits made while the native picker is open survive its success.
        native.locator("#save").click()
        request = wait_native_request(native, 3)
        assert request["action"] == "export" and request["filename"].endswith(".md") and request["text"] == "原始草稿"
        source_set(native, "请求后新编辑")
        native_result(native, {"id": request["id"], "filename": "导出.md"})
        native.wait_for_timeout(20)
        assert markdown(native) == "请求后新编辑"
        assert native.locator("#dirty").inner_text() == "•"

        native.locator("#save").click()
        request = wait_native_request(native, 4)
        native_result(native, {"id": request["id"], "canceled": True})
        native.wait_for_timeout(20)
        assert native.locator("#dirty").inner_text() == "•"
        native.locator("#save").click()
        request = wait_native_request(native, 5)
        native_result(native, {"id": request["id"], "error": "写入失败"})
        native.wait_for_timeout(20)
        assert native.locator("#dirty").inner_text() == "•"
        passed("Android export 取消/失败不清 dirty，成功按 snapshot 保存且保留请求后编辑")

        assert not errors, errors
        android.close()
        browser.close()

    if server:
        server.terminate()
        server.wait(timeout=5)
    result = {"passed": len(cases), "cases": cases, "pageErrors": errors, "note": "组合输入为合成事件；未声称真实设备/真实输入法覆盖。"}
    (ROOT / "mobile-results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ALL PASS: {len(cases)} cases", flush=True)


if __name__ == "__main__":
    run()
