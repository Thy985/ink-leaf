import json
import os
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get("INKSTONE_WEB_URL", "http://127.0.0.1:4173/")
RESULTS = ROOT / "test-results" / "web" / "v09-results.json"
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


def sidebar_transform(page):
    return page.evaluate("getComputedStyle(document.querySelector('.sidebar')).transform")


cases = []
server = wait_server()
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=os.environ.get("CHROMIUM_PATH"),
        args=["--no-sandbox"],
    )
    errors = []
    try:
        page = browser.new_page(viewport={"width": 1440, "height": 1040})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: dialog.accept())
        boot(page)

        # --- the syntax cheatsheet dialog opens and Esc closes only the dialog ---
        page.locator("#syntax-toggle").click()
        assert page.locator("#syntax-dialog").evaluate("d => d.open")
        assert "Markdown 语法速查" in page.locator("#syntax-dialog h2").inner_text()
        assert page.locator("#syntax-dialog .syntax-grid code").count() >= 15
        page.keyboard.press("Escape")
        assert not page.locator("#syntax-dialog").evaluate("d => d.open")
        cases.append("「语法」按钮打开速查面板，Esc 关闭且不影响其他状态")
        print("PASS", cases[-1], flush=True)

        # --- format button tooltips carry the syntax they insert ---
        assert "**文字**" in page.locator("button[data-command=bold]").get_attribute("title")
        assert "- [ ]" in page.locator("button[data-command=task]").get_attribute("title")
        assert "| 左 | 右 |" in page.locator("button[data-command=table]").get_attribute("title")
        assert "[文字](https://…)" in page.locator("button[data-command=link]").get_attribute("title")
        cases.append("格式按钮悬停提示包含对应 Markdown 语法")
        print("PASS", cases[-1], flush=True)

        # --- focus mode keeps the toolbar and its quick actions usable ---
        page.locator("#focus-toggle").click()
        assert page.evaluate("document.body.classList.contains('focus-mode')")
        assert page.locator(".toolbar").is_visible(), "toolbar must stay visible in focus mode"
        page.locator("#find-toggle").click()
        assert page.locator("#find-panel").is_visible()
        page.locator("#find-close").click()
        page.locator("#help-toggle").click()
        assert page.locator(".help").is_visible()
        page.locator("#help-toggle").click()
        # the syntax dialog must not let Esc leak into exiting focus mode
        page.locator("#syntax-toggle").click()
        page.keyboard.press("Escape")
        assert not page.locator("#syntax-dialog").evaluate("d => d.open")
        assert page.evaluate("document.body.classList.contains('focus-mode')"), "dialog Esc must not exit focus mode"
        page.keyboard.press("Escape")
        assert not page.evaluate("document.body.classList.contains('focus-mode')")
        cases.append("沉浸模式工具栏常驻，查找/帮助/语法可用且 Esc 语义正确")
        print("PASS", cases[-1], flush=True)

        # --- the outline peeks in when the mouse touches the left edge ---
        page.locator("#focus-toggle").click()
        page.wait_for_timeout(80)
        assert sidebar_transform(page) != "none", "outline starts hidden in focus mode"
        page.mouse.move(9, 400)
        page.wait_for_timeout(350)
        assert sidebar_transform(page) == "none", "hovering the left edge must reveal the outline"
        assert page.locator(".sidebar").bounding_box()["x"] == 0
        page.mouse.move(720, 400)
        page.wait_for_timeout(350)
        assert sidebar_transform(page) != "none", "leaving the outline hides it again"
        page.locator("#focus-toggle").click()
        assert not page.evaluate("document.body.classList.contains('focus-mode')")
        cases.append("沉浸模式下大纲随鼠标移到左缘悬停显示，移开即收起")
        print("PASS", cases[-1], flush=True)
        page.close()

        # --- touch devices keep the original minimal focus mode ---
        context = browser.new_context(viewport={"width": 393, "height": 852}, is_mobile=True, has_touch=True)
        mobile = context.new_page()
        mobile.on("pageerror", lambda error: errors.append(str(error)))
        boot(mobile)
        mobile.locator("#focus-toggle").click()
        assert mobile.evaluate("document.body.classList.contains('focus-mode')")
        assert not mobile.locator(".toolbar").is_visible(), "touch focus mode must keep the toolbar hidden"
        assert not mobile.locator(".sidebar").is_visible()
        mobile.locator("#exit-focus").click()
        context.close()
        cases.append("触屏端沉浸模式维持隐藏工具栏的原有行为")
        print("PASS", cases[-1], flush=True)
    finally:
        server and server.terminate()
        browser.close()

assert not errors, errors
RESULTS.write_text(json.dumps({"passed": len(cases), "cases": cases, "pageErrors": errors}, ensure_ascii=False, indent=2) + "\n")
print(f"ALL PASS: {len(cases)} cases", flush=True)
