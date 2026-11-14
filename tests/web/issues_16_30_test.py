import base64
import json
import os
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from inktest import app_ready, load as ink_load, markdown_contains, markdown_settled

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get("INKSTONE_WEB_URL", "http://127.0.0.1:4173/")
RESULTS = ROOT / "test-results" / "web" / "issues-16-30-results.json"
RESULTS.parent.mkdir(parents=True, exist_ok=True)
PNG = base64.b64encode(
    base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    )
).decode()


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
    app_ready(page)
    page.evaluate("() => localStorage.clear()")
    page.reload()
    app_ready(page)


def load(page, raw):
    ink_load(page, raw, name="issues.md")


def markdown(page):
    return page.evaluate("() => window.inkstone.getMarkdown()")


def caret(page, block=0, offset=None):
    page.evaluate(
        """({ block, offset }) => {
          const el = document.querySelector('#editor').children[block];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const nodes = []; let node;
          while ((node = walker.nextNode())) nodes.push(node);
          let left = offset === null ? el.textContent.length : offset;
          let target = el, at = 0;
          for (const candidate of nodes) {
            if (left <= candidate.length) { target = candidate; at = left; break; }
            left -= candidate.length;
          }
          document.querySelector('#editor').focus();
          const selection = getSelection();
          selection.setBaseAndExtent(target, at, target, at);
        }""",
        {"block": block, "offset": offset},
    )


def text_drop(page):
    return page.evaluate(
        """() => {
          const dt = new DataTransfer();
          dt.setData('text/plain', '拖放文本');
          const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
          document.querySelector('#editor').dispatchEvent(ev);
          return ev.defaultPrevented;
        }"""
    )


def export_html(page, path):
    with page.expect_download() as info:
        page.locator("#export-html").click()
    download = info.value
    download.save_as(path)
    return Path(path).read_text(encoding="utf-8")


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
        # #16: re-rendering a remote placeholder must not duplicate its action.
        load(page, "![远程](https://img.example/repeat.png)\n")
        for _ in range(3):
            page.locator("#source-toggle").click()
        assert page.locator('#editor .ink-image[data-ink-state="pending"]').count() == 1
        assert page.locator("#editor .ink-image-load").count() == 1
        # 奇数次切换后停在源码视图。打开文档不会自动退出源码视图（apply 会同步
        # source.value），所以这里显式切回编辑视图，后面的用例才有稳定的起点。
        page.locator("#source-toggle").click()
        assert page.locator("#source").is_hidden()
        cases.append("远程图片多次切换/渲染后仍只有一个加载按钮")

        # #18: plain text drops keep browser semantics; file drops remain claimed.
        load(page, "原文\n")
        toast_before = page.locator("#toast").inner_text()
        assert text_drop(page) is False
        page.wait_for_timeout(80)
        assert markdown(page) == "原文\n"
        assert page.locator("#toast").inner_text() == toast_before
        cases.append("编辑器纯文本 drop 不阻止、不触发文件导入提示")

        # #19/#24: source edits are reflected in exported HTML with valid footnote blocks.
        raw = "正文[^old] 与 [文档][ref]。\n\n[^old]: 旧定义\n[ref]: https://old.example/\n"
        load(page, raw)
        page.locator("#source-toggle").click()
        page.locator("#source").fill(
            "正文[^new] 与 [文档][ref]。\n\n[^new]: 新定义\n[^new]: 重复定义\n[ref]: https://new.example/\n"
        )
        page.locator("#source-toggle").click()
        out = export_html(page, ROOT / "test-results" / "web" / "issues-footnotes.html")
        assert "新定义" in out and "旧定义" not in out
        assert 'href="https://new.example/"' in out
        assert out.count('id="ink-fn-1"') == 1
        assert "<p><div" not in out and "<div><p" not in out
        assert '<div class="ink-fn" id="ink-fn-1">' in out
        cases.append("源码修改后的脚注/链接定义进入导出 HTML，脚注块合法且重复定义唯一")

        # #26: save/open work from find inputs, while editing shortcuts yield to inputs/dialogs.
        load(page, "输入内容")
        page.evaluate(
            """() => {
              window.__savePickerCalls = 0;
              window.showSaveFilePicker = async () => { window.__savePickerCalls++; throw Object.assign(new Error('test'), { name: 'AbortError' }); };
              window.__openPickerCalls = 0;
              window.showOpenFilePicker = async () => { window.__openPickerCalls++; throw Object.assign(new Error('test'), { name: 'AbortError' }); };
              window.__openClicks = 0;
              document.querySelector('#file-input').addEventListener('click', () => window.__openClicks++);
            }"""
        )
        page.locator("#find-toggle").click()
        find_input = page.locator("#find-input")
        find_input.fill("输入")
        find_input.press("Control+s")
        find_input.press("Control+o")
        page.wait_for_timeout(100)
        assert page.evaluate("() => window.__savePickerCalls") == 1
        # Chromium 实现了 File System Access，打开走原生选择器而不是 #file-input
        # 兜底；两者互斥，所以这里断言原生选择器被调用、兜底输入未被点击。
        assert page.evaluate("() => window.__openPickerCalls") == 1
        assert page.evaluate("() => window.__openClicks") == 0
        page.locator("#rename").click()
        name_input = page.locator("#name-input")
        name_input.fill("保留输入")
        name_input.press("Control+b")
        assert name_input.input_value() == "保留输入"
        # 对话框是 showModal 打开的，不关掉会挡住后面的 #save 点击。
        page.locator('#name-dialog button[value=cancel]').click()
        assert not page.locator("#name-dialog").evaluate("d => d.open")
        cases.append("查找输入可用 Ctrl+S/Ctrl+O，普通输入与对话框不被编辑快捷键抢夺")

        # #27: invalid UTF-8 through the real file input leaves document and handle state intact.
        load(page, "保留文档\n")
        page.locator("#file-input").set_input_files(
            {"name": "坏编码.md", "mimeType": "text/markdown", "buffer": bytes([0xC0, 0xFF, 0x61])}
        )
        page.wait_for_timeout(150)
        assert markdown(page) == "保留文档\n"
        assert "UTF-8" in page.locator("#toast").inner_text()
        assert "已打开" not in page.locator("#toast").inner_text()
        cases.append("非法 UTF-8 导入显示明确中文失败信息且不改文档")

        # #28: rejected writable aborts and preserves the Markdown snapshot.
        load(page, "保存前内容\n")
        page.evaluate(
            """() => {
              window.__aborts = 0;
              window.showSaveFilePicker = async () => ({
                name: '拒绝.md',
                createWritable: async () => ({
                  async write() { throw new Error('write rejected'); },
                  async close() { throw new Error('close rejected'); },
                  async abort() { window.__aborts++; },
                }),
                getFile: async () => ({ name: '拒绝.md' }),
              });
            }"""
        )
        page.locator("#save").click()
        page.wait_for_timeout(250)
        assert page.evaluate("() => window.__aborts") == 1
        assert markdown(page) == "保存前内容\n"
        assert "写入失败" in page.locator("#toast").inner_text()
        cases.append("FSA write 拒绝时调用 abort 且保留文档内容")

        # #29: delayed image read freezes both editors, then restores them and uses captured caret.
        load(page, "首行\n\n末行\n")
        caret(page, 2, None)
        page.evaluate(
            """(png) => {
              class DelayedReader {
                readAsDataURL() { setTimeout(() => { this.result = 'data:image/png;base64,' + png; this.onload(); }, 120); }
              }
              window.FileReader = DelayedReader;
            }""",
            PNG,
        )
        page.evaluate(
            """() => {
              const dt = new DataTransfer();
              dt.items.add(new File([new Uint8Array([1])], 'delayed.png', { type: 'image/png' }));
              const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
              Object.defineProperty(ev, 'clipboardData', { value: dt });
              document.querySelector('#editor').dispatchEvent(ev);
            }"""
        )
        assert page.locator("#editor").get_attribute("contenteditable") == "false"
        assert page.locator("#source").is_editable() is False
        page.wait_for_timeout(300)
        assert markdown(page).endswith("末行![粘贴图片](data:image/png;base64," + PNG + ")\n")
        assert page.locator("#editor").get_attribute("contenteditable") == "true"
        assert page.locator("#source").is_editable() is True
        cases.append("延迟图片读取期间编辑器冻结，结束后恢复并落在捕获光标范围")
    finally:
        server and server.terminate()
        browser.close()

assert not errors, errors
RESULTS.write_text(json.dumps({"passed": len(cases), "cases": cases, "pageErrors": errors}, ensure_ascii=False, indent=2) + "\n")
print(f"ALL PASS: {len(cases)} cases", flush=True)
