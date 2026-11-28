"""issue #52: block markers are not editable text.

Typora keeps block-level Markdown markers (`# `, `- `, `> `, `1. `) out of the text flow
entirely; they never appear just because the caret is in the block. This suite pins that
contract: markers are non-editable decorations excluded from the DOM text, a caret at the
line start is a Backspace format operation, and the source round-trips byte for byte.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from inktest import app_ready, load as ink_load

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get("INKSTONE_WEB_URL", "http://127.0.0.1:4173/")
RESULTS = ROOT / "test-results" / "web" / "issue52-results.json"
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
    app_ready(page)
    page.evaluate("() => localStorage.clear()")
    page.reload()
    app_ready(page)


def load(page, raw):
    ink_load(page, raw, name="issue52.md")


def markdown(page):
    return page.evaluate("() => window.inkstone.getMarkdown()")


def blur(page):
    page.locator("#status").click()
    page.wait_for_timeout(60)


def content_caret(page, index=0, at=None):
    """Place the caret inside a block's editable run (never on its decoration)."""
    page.evaluate(
        """({ index, at }) => {
          const editor = document.getElementById('editor');
          const block = editor.children[index];
          editor.focus();
          const run = block.querySelector('.block-content') || block;
          const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
          const nodes = []; let node;
          while ((node = walker.nextNode())) nodes.push(node);
          let left = at === null || at === undefined ? run.textContent.length : at;
          let target = run, off = 0;
          for (const candidate of nodes) {
            if (left <= candidate.length) { target = candidate; off = left; break; }
            target = candidate; off = candidate.length; left -= candidate.length;
          }
          const selection = getSelection();
          selection.setBaseAndExtent(target, off, target, off);
        }""",
        {"index": index, "at": at},
    )
    page.wait_for_timeout(40)


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
        raw = "## 标题\n\n- 列表项\n\n> 引用\n\n1. 有序\n"
        load(page, raw)
        blur(page)
        # The block text a reader sees never contains the marker, whether focused or not.
        assert page.locator("#editor .heading .block-content").first.inner_text() == "标题"
        assert page.locator("#editor .list .block-content").first.inner_text() == "列表项"
        assert page.locator("#editor .quote .block-content").first.inner_text() == "引用"
        assert page.locator("#editor .block-mark").first.is_hidden()
        cases.append("标题/列表/引用/有序列表的标记不是可编辑文本")
        print("PASS", cases[-1], flush=True)

        # Clicking into the block must not summon the marker back (the reported bug).
        page.locator("#editor .heading .block-content").first.click()
        page.wait_for_timeout(120)
        assert page.locator("#editor .heading .block-content").first.inner_text() == "标题"
        assert page.locator("#editor .heading .block-mark").first.is_hidden()
        cases.append("光标落在块内也不再显示 ## ")
        print("PASS", cases[-1], flush=True)

        # A caret at the line start plus Backspace is an explicit format operation.
        content_caret(page, 0, 0)
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "标题\n\n- 列表项\n\n> 引用\n\n1. 有序\n", repr(markdown(page))
        assert page.locator("#editor .heading").count() == 0
        cases.append("行首退格把标题变回正文")
        print("PASS", cases[-1], flush=True)

        # Undo restores the marker exactly.
        page.keyboard.press("Control+z")
        page.wait_for_timeout(150)
        assert markdown(page) == raw, repr(markdown(page))
        cases.append("撤销恢复 ## 标记")
        print("PASS", cases[-1], flush=True)

        # A list item and a quote behave the same way.
        load(page, raw)
        blur(page)
        content_caret(page, 2, 0)
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page).startswith("## 标题\n\n列表项\n"), repr(markdown(page))
        load(page, raw)
        blur(page)
        content_caret(page, 4, 0)
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert "> 引用" not in markdown(page) and "引用" in markdown(page), repr(markdown(page))
        cases.append("列表与引用行首退格同样撤销格式")
        print("PASS", cases[-1], flush=True)

        # Selecting a line and copying yields content without the marker.
        load(page, raw)
        blur(page)
        page.evaluate(
            """() => {
              const block = document.getElementById('editor').children[0];
              const run = block.querySelector('.block-content');
              const range = document.createRange();
              range.selectNodeContents(run);
              const selection = getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              return selection.toString();
            }"""
        )
        selected = page.evaluate("() => getSelection().toString()")
        assert "##" not in selected and "标题" in selected, repr(selected)
        assert markdown(page) == raw
        cases.append("选中标题行不带上 ## ")
        print("PASS", cases[-1], flush=True)

        # Task items keep a single clickable box instead of `- [ ] ` text.
        load(page, "- [ ] 待办\n")
        blur(page)
        assert page.locator("#editor .task-box").count() == 1
        assert "[ ]" not in page.locator("#editor .list").first.inner_text()
        page.locator("#editor .task-box").click()
        page.wait_for_timeout(120)
        assert markdown(page) == "- [x] 待办\n", repr(markdown(page))
        cases.append("任务项显示复选框而不是 - [ ] 文本")
        print("PASS", cases[-1], flush=True)

        # Typing at the end of a decorated heading stays in the heading.
        load(page, "## 标题")
        blur(page)
        content_caret(page, 0, None)
        page.keyboard.type("续")
        page.wait_for_timeout(120)
        assert markdown(page) == "## 标题续", repr(markdown(page))
        # Enter at the end starts a paragraph after the heading, marker intact.
        page.keyboard.press("Enter")
        page.keyboard.type("下一段")
        page.wait_for_timeout(120)
        assert markdown(page) == "## 标题续\n\n下一段", repr(markdown(page))
        cases.append("装饰化标题的续写与 Enter 分段")
        print("PASS", cases[-1], flush=True)

        # Editing one block must not disturb the marker of another: a task item's `- [ ] ` is a
        # checkbox in the DOM, and a DOM re-read has to put the source prefix back.
        load(page, "## 标题\n\n- [ ] 任务\n\n> 引用\n")
        blur(page)
        content_caret(page, 0, 2)
        page.keyboard.type("X")
        page.wait_for_timeout(120)
        assert markdown(page) == "## 标题X\n\n- [ ] 任务\n\n> 引用\n", repr(markdown(page))
        page.locator("#editor .task-box").click()
        page.wait_for_timeout(120)
        assert markdown(page) == "## 标题X\n\n- [x] 任务\n\n> 引用\n", repr(markdown(page))
        cases.append("编辑旁块不丢失任务项前缀，勾选仍生效")
        print("PASS", cases[-1], flush=True)

        # Rich marked blocks render their full raw source in `.block-source`; their caret offsets
        # must not be shifted by the hidden decoration prefix.
        load(page, "## H $x$\n\n- item $y$\n")
        blur(page)
        page.locator("#editor .heading .block-preview").click()
        page.wait_for_timeout(80)
        assert page.locator("#editor .heading .block-source").is_visible()
        page.evaluate(
            """() => {
              const source = document.querySelector('#editor .heading .block-source');
              const node = source.firstChild;
              const r = document.createRange();
              r.setStart(node, 4); r.collapse(true);
              const s = getSelection(); s.removeAllRanges(); s.addRange(r);
            }"""
        )
        page.wait_for_timeout(60)
        assert page.evaluate("() => window.inkstoneGetSelection().f") == 4
        page.keyboard.type("Z")
        page.wait_for_timeout(120)
        assert markdown(page) == "## HZ $x$\n\n- item $y$\n", repr(markdown(page))
        cases.append("富块标题的源码光标偏移不被隐藏标记吞掉")
        print("PASS", cases[-1], flush=True)

        # Setext underline is a decoration too, and round-trips.
        load(page, "标题\n====\n\n正文\n")
        blur(page)
        assert page.locator("#editor .heading .block-content").first.inner_text() == "标题"
        assert page.locator("#editor .heading .setext-underline").first.is_hidden()
        assert markdown(page) == "标题\n====\n\n正文\n"
        cases.append("Setext 下划线同样不进入正文文本")
        print("PASS", cases[-1], flush=True)

        # Inline markers stay hidden mid-block and only surface next to the caret.
        load(page, "一段 **粗体** 与 *斜体* 和 [链接](https://example.com) 文字\n")
        blur(page)
        content_caret(page, 0, 0)
        page.wait_for_timeout(80)
        visible_before = [page.locator("#editor .syntax").nth(i).is_visible()
                          for i in range(page.locator("#editor .syntax").count())]
        assert not any(visible_before[:2]), visible_before
        assert "**" not in page.locator("#editor .paragraph .block-content").first.inner_text()
        cases.append("行内标记不在块中间无端展开")
        print("PASS", cases[-1], flush=True)

        assert not errors, errors
    finally:
        RESULTS.write_text(
            json.dumps({"passed": len(cases), "cases": cases, "pageErrors": errors}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        browser.close()
        if server:
            server.terminate()
            server.wait(timeout=5)

print("ALL PASS", len(cases), flush=True)
