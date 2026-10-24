from pathlib import Path
import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get("INKSTONE_WEB_URL", "http://127.0.0.1:4173/")
RESULTS = ROOT / "test-results" / "web" / "v05-results.json"
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
        {"name": "v05.md", "mimeType": "text/markdown", "buffer": raw.encode("utf-8")}
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


def blocks(page):
    return page.evaluate("window.inkstone.getBlocks().map(({type, label, body}) => ({type, label, body}))")


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
        # --- footnote definition block ---
        raw = "正文[^note]\n\n段落二\n\n[^note]: 说明文字\n"
        load(page, raw)
        blur(page)
        types = [b["type"] for b in blocks(page)]
        assert types[0] == "paragraph" and "footnoteDef" in types, types
        assert page.locator("#editor .footnote-def").count() == 1
        assert page.locator('#editor .footnote-def a[href="#ink-ref-1"]').count() == 1
        assert "说明文字" in page.locator("#editor .footnote-def").inner_text()
        assert markdown(page) == raw
        cases.append("脚注定义成为独立块并显示序号与回链")
        print("PASS", cases[-1], flush=True)

        # --- reference renders as a superscript anchor ---
        assert page.locator('#editor sup a[href="#ink-fn-1"]').count() == 1
        assert page.evaluate(
            "() => getComputedStyle(document.querySelector('#editor sup.fn-ref a'), '::after').content"
        ) == '"1"'
        assert page.locator("#editor sup.fn-ref a").bounding_box()["width"] > 0
        assert page.locator("#editor .paragraph .syntax").first.is_hidden()
        cases.append("脚注引用显示为角标数字")
        print("PASS", cases[-1], flush=True)

        # --- the generated number must not shift caret mapping ---
        caret(page, 0)
        page.keyboard.type("补")
        page.wait_for_timeout(80)
        assert markdown(page) == "正文[^note]补\n\n段落二\n\n[^note]: 说明文字\n", markdown(page)
        page.keyboard.press("Control+z")
        page.wait_for_timeout(120)
        assert markdown(page) == raw
        cases.append("角标是生成内容，光标映射仍与原文对齐")
        print("PASS", cases[-1], flush=True)

        # --- clicking the reference scrolls to the definition, never opens a window ---
        opened = []
        page.once("popup", lambda p: opened.append(p.url))
        page.locator('#editor sup a[href="#ink-fn-1"]').click()
        page.wait_for_timeout(120)
        assert not opened, opened
        assert page.locator("#editor .footnote-def.flash").count() == 1
        cases.append("点击引用跳到定义且不新开窗口")
        print("PASS", cases[-1], flush=True)

        # --- clicking the back reference jumps to the referencing block ---
        page.locator('#editor .footnote-def a[href="#ink-ref-1"]').click()
        page.wait_for_timeout(120)
        assert page.locator("#editor .paragraph.flash").count() == 1
        cases.append("回链跳回引用所在块")
        print("PASS", cases[-1], flush=True)

        # --- definition block is editable in place (non-rich blocks reveal their syntax) ---
        assert [b["type"] for b in blocks(page)][4] == "footnoteDef"
        caret(page, 4)
        assert page.locator("#editor .footnote-def.active").count() == 1
        assert page.locator("#editor .footnote-def .syntax").first.is_visible()
        assert "[^note]: " in page.locator("#editor .footnote-def").inner_text()
        blur(page)
        assert page.locator("#editor .footnote-def .syntax").first.is_hidden()
        assert markdown(page) == raw
        cases.append("点击脚注定义可编辑原文且无损")
        print("PASS", cases[-1], flush=True)

        # --- unpaired and escaped references stay literal ---
        raw = "未定义 [^gone] 与转义 \\[^note] 与已定义 [^note]\n\n[^note]: 说明\n"
        load(page, raw)
        blur(page)
        assert page.locator("#editor sup").count() == 1
        text = page.locator("#editor .paragraph").text_content()
        assert "未定义 [^gone]" in text, text
        assert "与转义 \\[^note]" in text, text
        assert markdown(page) == raw
        cases.append("未配对与转义的引用原样显示")
        print("PASS", cases[-1], flush=True)

        # --- unreferenced definition keeps its source visible ---
        raw = "正文[^used]\n\n[^used]: 在用\n[^loose]: 没人引用\n"
        load(page, raw)
        blur(page)
        assert page.locator("#editor .footnote-def").count() == 2
        loose = page.locator("#editor .footnote-def").nth(1)
        assert "[^loose]:" in loose.inner_text()
        assert loose.locator("a").count() == 0
        assert markdown(page) == raw
        cases.append("未被引用的定义原样可见且不占编号")
        print("PASS", cases[-1], flush=True)

        # --- duplicate definitions: first wins, second stays visible ---
        raw = "正文[^a]\n\n[^a]: 第一\n[^a]: 第二\n"
        load(page, raw)
        blur(page)
        assert page.locator('#editor sup a[href="#ink-fn-1"]').count() == 1
        second = page.locator("#editor .footnote-def").nth(1)
        assert "[^a]:" in second.inner_text()
        assert "第二" in second.inner_text()
        assert markdown(page) == raw
        cases.append("重复定义首个生效但后续原文不隐藏")
        print("PASS", cases[-1], flush=True)

        # --- rich block (table) reference through the markdown-it path ---
        raw = "| 列 | 注 |\n| --- | --- |\n| 值 | 见[^t]与[文档][docs] |\n\n[^t]: 表格脚注\n[docs]: https://example.com/docs\n"
        load(page, raw)
        blur(page)
        assert page.locator('.block-preview table sup a[href="#ink-fn-1"]').count() == 1
        assert page.locator('.block-preview table a[href="https://example.com/docs"]').count() == 1
        assert page.locator('.block-preview table a[href="https://example.com/docs"]').inner_text() == "文档"
        assert markdown(page) == raw
        cases.append("表格富块内的脚注与链接引用同样生效")
        print("PASS", cases[-1], flush=True)

        # --- link reference definitions ---
        raw = "读 [仓库][repo] 与 [缺][gone]\n\n[repo]: https://example.com/repo \"标题\"\n"
        load(page, raw)
        blur(page)
        assert page.locator("#editor .paragraph a[href='https://example.com/repo']").count() == 1
        assert page.locator("#editor .link-def").count() == 1
        assert page.locator("#editor .link-def a[href='https://example.com/repo']").count() == 1
        assert "https://example.com/repo" in page.locator("#editor .link-def").inner_text()
        assert "[缺][gone]" in page.locator("#editor .paragraph").inner_text()
        assert markdown(page) == raw
        cases.append("链接引用生效、未定义原样、定义行可见")
        print("PASS", cases[-1], flush=True)

        # --- unsafe link reference targets never become anchors ---
        raw = "危险 [x][evil]\n\n[evil]: javascript:window.BAD=1\n"
        load(page, raw)
        blur(page)
        assert page.evaluate("Boolean(window.BAD)") is False
        assert page.locator("#editor a[href^='javascript:']").count() == 0
        assert "[x][evil]" in page.locator("#editor .paragraph").text_content()
        assert markdown(page) == raw
        cases.append("javascript: 链接引用目标不生成锚点")
        print("PASS", cases[-1], flush=True)

        # --- footnote body HTML is sanitized ---
        raw = "带攻击[^x]\n\n[^x]: <img src=x onerror=window.BAD=1><script>window.BAD=1</script>正文\n"
        load(page, raw)
        blur(page)
        page.locator("#editor .footnote-def").click()
        blur(page)
        assert page.evaluate("Boolean(window.BAD)") is False
        assert page.locator("#editor .footnote-def img, #editor .footnote-def script").count() == 0
        assert "正文" in page.locator("#editor .footnote-def").inner_text()
        assert markdown(page) == raw
        cases.append("脚注正文里的脚本与图片被过滤")
        print("PASS", cases[-1], flush=True)

        # --- a rich footnote body keeps its number and back reference ---
        raw = "正文[^r]\n\n[^r]: 来源 <https://example.com>\n"
        load(page, raw)
        blur(page)
        assert page.locator("#editor .footnote-def .block-preview").count() == 1
        assert page.locator('#editor .footnote-def a.fn-back[href="#ink-ref-1"]').count() == 1
        assert page.evaluate(
            "() => getComputedStyle(document.querySelector('#editor .footnote-def a.fn-back'), '::after').content"
        ) == '"1."'
        assert page.locator("#editor .footnote-def a.fn-back").bounding_box()["width"] > 0
        page.locator('#editor .footnote-def a.fn-back').click()
        page.wait_for_timeout(120)
        assert page.locator("#editor .paragraph.flash").count() == 1
        assert markdown(page) == raw
        cases.append("富预览的脚注定义仍保留序号与回链")
        print("PASS", cases[-1], flush=True)

        # --- a definition may follow a heading directly (it cannot interrupt a paragraph) ---
        raw = "正文[^1]\n\n# 参考文献\n[^1]: 紧跟标题的定义\n"
        load(page, raw)
        blur(page)
        assert [b["type"] for b in blocks(page)] == ["paragraph", "blank", "heading", "footnoteDef", "blank"], blocks(page)
        assert page.locator('#editor .footnote-def a[href="#ink-ref-1"]').count() == 1
        assert page.locator('#editor sup a[href="#ink-fn-1"]').count() == 1
        assert markdown(page) == raw
        caret(page, 0)
        page.keyboard.type("续")
        page.wait_for_timeout(80)
        assert markdown(page) == raw.replace("正文[^1]", "正文[^1]续", 1), markdown(page)
        page.keyboard.press("Control+z")
        page.wait_for_timeout(120)
        assert markdown(page) == raw
        cases.append("标题后紧跟的定义生效且段落里的定义仍算原文")
        print("PASS", cases[-1], flush=True)

        # --- only references a renderer can anchor may take a number (rich path) ---
        raw = 'A <!-- [^gone] --> B <b>[^live]</b> C <a href="q[^attr]r">x</a>\n\n[^gone]: 注释里的\n[^live]: 可见的\n[^attr]: 属性里的\n'
        load(page, raw)
        blur(page)
        assert page.locator("#editor .footnote-def").count() == 3
        assert page.locator("#editor sup").count() == 1, page.locator("#editor sup").count()
        assert page.locator('#editor .block-preview sup a[href="#ink-fn-1"]').count() == 1
        live = page.locator("#editor .footnote-def").nth(1)
        assert live.locator('a[href="#ink-ref-1"]').count() == 1
        for hidden in (0, 2):
            unfired = page.locator("#editor .footnote-def").nth(hidden)
            assert unfired.locator("a").count() == 0, unfired.inner_text()
        assert "[^gone]:" in page.locator("#editor .footnote-def").nth(0).inner_text()
        assert "[^attr]:" in page.locator("#editor .footnote-def").nth(2).inner_text()
        assert markdown(page) == raw
        cases.append("注释与标签属性里的引用不占号，可见引用正常编号")
        print("PASS", cases[-1], flush=True)

        # --- mixed document round-trips exactly ---
        raw = (
            "标题[^1]\n====\n\n段落 [文字][repo]\n\n| a | b |\n| --- | --- |\n| c | 注[^2] |\n\n"
            "```js\nconst x = 1;\n```\n\n[^1]: 第一\n[^2]: 第二\n[repo]: https://example.com\n"
        )
        load(page, raw)
        blur(page)
        assert page.locator("#editor .heading").count() == 1
        assert page.locator("#editor .code").count() == 1
        assert page.locator("#editor sup").count() == 2
        assert page.locator("#editor .paragraph a[href='https://example.com']").count() == 1
        assert page.locator("#editor .link-def a[href='https://example.com']").count() == 1
        assert markdown(page) == raw
        page.locator("#source-toggle").click()
        assert page.locator("#source").input_value() == raw
        page.locator("#source-toggle").click()
        assert markdown(page) == raw
        cases.append("混合文档显示与 round-trip 无损")
        print("PASS", cases[-1], flush=True)

        # --- mobile width and dark theme ---
        page.set_viewport_size({"width": 393, "height": 844})
        page.wait_for_timeout(120)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.locator("#theme-toggle").click()
        assert page.locator("html").get_attribute("data-theme") == "dark"
        cases.append("393px 无横向溢出与深色主题")
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
