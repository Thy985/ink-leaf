from pathlib import Path
import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright
from inktest import app_ready, load as ink_load, markdown_settled, markdown_contains, visible_text

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
    app_ready(page)
    page.evaluate("() => localStorage.clear()")
    page.reload()
    app_ready(page)


def load(page, raw):
    ink_load(page, raw, name="v04.md")


def markdown(page):
    return page.evaluate("() => window.inkstone.getMarkdown()")


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


def select_text(page, index, start, end):
    page.evaluate(
        """({ index, start, end }) => {
          const el = document.getElementById('editor').children[index];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const nodes = [];
          let node;
          while ((node = walker.nextNode())) nodes.push(node);
          let left = start, a = null, ao = 0, b = null, bo = 0;
          for (const candidate of nodes) {
            if (a === null && left <= candidate.length) { a = candidate; ao = left; }
            if (b === null && end <= candidate.length) { b = candidate; bo = end; break; }
            left = Math.max(0, left - candidate.length);
            end = Math.max(0, end - candidate.length);
          }
          const selection = getSelection();
          selection.setBaseAndExtent(a, ao, b, bo);
        }""",
        {"index": index, "start": start, "end": end},
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

        raw = "```js\n" + "const x = 1;\n" * 9000 + "```\n"
        load(page, raw)
        blur(page)
        preview = page.locator("#editor .code .block-preview")
        assert preview.locator(".hljs-keyword").count() == 0
        assert preview.locator("pre span").count() == 0
        assert markdown(page) == raw
        cases.append("超长代码回退纯文本")
        print("PASS", cases[-1], flush=True)

        raw = '```html\n</code><img src=x onerror="window.BAD=1"><script>window.BAD=2</script>\n```\n'
        load(page, raw)
        blur(page)
        assert not page.evaluate("() => Boolean(window.BAD)")
        assert page.locator("#editor .block-preview img, #editor .block-preview script").count() == 0
        assert markdown(page) == raw
        cases.append("代码内容 XSS 防护")
        print("PASS", cases[-1], flush=True)

        # The class filter must only touch span tags: `<` is escaped in text nodes,
        # so code text containing class="..." must survive untouched.
        raw = '```js\nconst s = \'class="foo"\';\nconst answer = 42;\n```\n'
        load(page, raw)
        blur(page)
        preview = page.locator("#editor .code .block-preview pre code")
        assert 'class="foo"' in preview.text_content(), repr(preview.text_content())
        assert preview.locator(".hljs-keyword").count() >= 1
        assert markdown(page) == raw
        cases.append("高亮预览保留代码文本中的 class 字面量")
        print("PASS", cases[-1], flush=True)

        # --- setext headings ---
        raw = "标题\n====\n\n二级\n---\n"
        load(page, raw)
        blur(page)
        assert page.locator("#editor .heading").count() == 2
        assert visible_text(page.locator("#editor .heading").nth(0)) == "标题"
        assert page.locator("#outline button").nth(0).inner_text() == "标题"
        assert page.locator("#editor .heading .setext-underline").nth(0).is_hidden()
        assert markdown(page) == raw
        page.locator("#editor .heading").nth(0).click()
        # 块级标记（含 Setext 下划线）不再随光标展开；激活只影响富块与行内标记。
        page.wait_for_timeout(80)
        assert page.locator("#editor .heading .setext-underline").nth(0).is_hidden()
        cases.append("Setext 标题显示、大纲正常，下划线激活后仍隐藏")
        print("PASS", cases[-1], flush=True)

        load(page, "段落\n---\n\n---\n")
        blur(page)
        blocks = page.evaluate("() => window.inkstone.getBlocks()")
        types = [block["type"] for block in blocks]
        assert blocks[0]["type"] == "heading" and blocks[0]["level"] == 2
        assert "hr" in types
        assert markdown(page) == "段落\n---\n\n---\n"
        cases.append("Setext 与分割线优先级")
        print("PASS", cases[-1], flush=True)

        load(page, "Title\n===")
        caret(page, 0, 0)
        page.locator('[data-command="h2"]').click()
        assert markdown(page) == "Title\n---"
        page.locator('[data-command="h1"]').click()
        assert markdown(page) == "Title\n==="
        caret(page, 0, len("Title"))
        page.keyboard.press("Enter")
        page.keyboard.insert_text("next")
        assert markdown(page) == "Title\n===\n\nnext"
        cases.append("Setext H1/H2 替换与末尾 Enter")
        print("PASS", cases[-1], flush=True)

        # Formatting keeps the caret in the content so typing cannot strand the underline.
        load(page, "Title\n===")
        caret(page, 0, len("Title"))
        page.locator('[data-command="h2"]').click()
        assert markdown(page) == "Title\n---"
        page.keyboard.insert_text("x")
        assert markdown(page) == "Titlex\n---", repr(markdown(page))
        blocks = page.evaluate("() => window.inkstone.getBlocks()")
        assert blocks[0]["type"] == "heading" and blocks[0]["style"] == "setext"
        assert blocks[0]["level"] == 2
        cases.append("Setext 标题格式化后继续输入仍保持 Setext")
        print("PASS", cases[-1], flush=True)

        # A selection inside a Setext heading replaces only the underline.
        load(page, "Title\n---")
        select_text(page, 0, 0, len("Title"))
        page.locator('[data-command="h1"]').click()
        assert markdown(page) == "Title\n===", repr(markdown(page))
        blocks = page.evaluate("() => window.inkstone.getBlocks()")
        assert blocks[0]["type"] == "heading" and blocks[0]["style"] == "setext"
        assert blocks[0]["level"] == 1
        cases.append("Setext 标题内选中文本切换 H1/H2")
        print("PASS", cases[-1], flush=True)

        # The hr command uses *** so it is never read back as a Setext underline.
        load(page, "para\nnext")
        caret(page, 0, len("para\n"))
        page.locator('[data-command="hr"]').click()
        blocks = page.evaluate("() => window.inkstone.getBlocks()")
        assert any(block["type"] == "hr" for block in blocks), blocks
        assert markdown(page) == "para\n***\n\nnext", repr(markdown(page))
        cases.append("分割线命令插入 *** 而不是 Setext 下划线")
        print("PASS", cases[-1], flush=True)

        load(page, "## 标题 ##")
        blur(page)
        assert visible_text(page.locator("#editor .heading")) == "标题"
        assert page.locator("#outline button").inner_text() == "标题"
        assert markdown(page) == "## 标题 ##"
        cases.append("ATX 闭合井号显示与大纲")

        # 块级前缀永不随光标展开；行内标记只在光标所在/紧邻处展开。
        load(page, "## 标题 **粗体** 尾\n")
        blur(page)
        heading = page.locator("#editor .heading")
        assert heading.locator(".block-marker").first.is_hidden()
        caret(page, 0, len("## 标题 "))
        page.wait_for_timeout(80)
        assert heading.locator(".block-marker").first.is_hidden()
        assert heading.locator(".syntax.reveal").count() == 1
        assert heading.locator(".syntax.reveal").first.inner_text() == "**"
        caret(page, 0, len("## 标题 **粗体"))
        page.wait_for_timeout(80)
        assert heading.locator(".syntax.reveal").count() == 1
        assert heading.locator(".syntax.reveal").first.inner_text() == "**"
        caret(page, 0, len("## 标题 **粗"))
        page.wait_for_timeout(80)
        assert heading.locator(".syntax.reveal").count() == 0
        assert heading.locator(".block-marker").first.is_hidden()
        assert markdown(page) == "## 标题 **粗体** 尾\n"
        cases.append("块级前缀常隐、行内标记仅紧邻处展开")

        # 块首退格＝删块级前缀并降为正文：不删字符、不合并上一块，且一步可撤销。
        demote = [
            ("## 标题 ##", "标题", "ATX 标题（含闭合井号）"),
            ("- 无序项", "无序项", "无序列表"),
            ("1. 有序项", "有序项", "有序列表"),
            ("- [ ] 任务项", "任务项", "任务列表"),
            ("> 引用行", "引用行", "引用"),
        ]
        for source, expected, label in demote:
            load(page, "上一段\n\n" + source + "\n")
            caret(page, 2, 0)  # 隐藏前缀之前的位置
            page.keyboard.press("Backspace")
            page.wait_for_timeout(120)
            assert markdown(page) == "上一段\n\n" + expected + "\n", (label, markdown(page))
            page.keyboard.press("Control+z")
            page.wait_for_timeout(120)
            assert markdown(page) == "上一段\n\n" + source + "\n", (label, "undo", markdown(page))
            cases.append(f"块首退格降级：{label}，可撤销")
            print("PASS", cases[-1], flush=True)

        # 光标落在隐藏前缀之后的可见起点（Home/点击落点），同样触发降级。
        load(page, "## 标题\n")
        caret(page, 0, len("## "))
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "标题\n", markdown(page)
        cases.append("块首退格：可见起点同样降级")

        # 块内容中部退格仍是普通删字符，不触发降级。
        load(page, "## 标题\n")
        caret(page, 0, len("## 标"))
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "## 题\n", markdown(page)
        cases.append("块中部退格不触发降级")

        # Setext 标题删掉下划线行，正文保留。
        load(page, "标题\n===\n")
        caret(page, 0, 0)
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "标题\n", markdown(page)
        cases.append("块首退格降级：Setext 标题")

        # 空内容块（只有 pending 前缀）降级后不留悬空前缀。
        load(page, "## \n")
        caret(page, 0, 0)
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert "##" not in markdown(page) and markdown(page).strip() == "", markdown(page)
        cases.append("块首退格降级：空标题不留悬空前缀")

        # 缩进列表项先降一级缩进，再删标记降为正文。
        load(page, "- 父项\n\n  - 子项\n")
        caret(page, 2, 0)
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "- 父项\n\n- 子项\n", markdown(page)
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "- 父项\n\n子项\n", markdown(page)
        cases.append("块首退格降级：缩进列表先减缩进再降级")

        # 普通段落行首退格仍是合并上一块，既有行为不被改坏。
        load(page, "甲\n\n乙\n")
        caret(page, 2, 0)
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "甲\n乙\n", markdown(page)
        cases.append("普通段落行首退格仍合并上一块")
        print("PASS", cases[-1], flush=True)

        # 行内解包：光标贴在可见文字起点时退格，删掉一对标记并保留文字，一步可撤销。
        inline_unwrap = [
            ("**粗体**", 2, "粗体", "粗体"),
            ("*斜体*", 1, "斜体", "斜体"),
            ("`代码`", 1, "代码", "行内代码"),
            ("` 代码 `", 2, "代码", "带衬空的行内代码"),
            ("[链接](https://example.com)", 1, "链接", "链接"),
            ("~~删除~~", 2, "删除", "删除线"),
            ("__粗体__", 2, "粗体", "下划线粗体"),
        ]
        for source, offset, expected, label in inline_unwrap:
            load(page, source + "\n")
            caret(page, 0, offset)
            page.keyboard.press("Backspace")
            page.wait_for_timeout(120)
            assert markdown(page) == expected + "\n", (label, markdown(page))
            page.keyboard.press("Control+z")
            page.wait_for_timeout(120)
            assert markdown(page) == source + "\n", (label, "undo", markdown(page))
            cases.append(f"行内解包：{label}，一步可撤销")
            print("PASS", cases[-1], flush=True)

        # 解包后光标留在文字之前：接着输入应出现在文字前面。
        load(page, "**粗体**\n")
        caret(page, 0, 2)
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        page.keyboard.insert_text("新")
        page.wait_for_timeout(120)
        assert markdown(page) == "新粗体\n", markdown(page)
        cases.append("行内解包后光标停在文字前")

        def selection_blocks():
            return page.evaluate(
                """() => {
                  const editor = document.getElementById('editor');
                  const info = (node) => {
                    const el = node.nodeType === 3 ? node.parentElement : node;
                    const block = el.closest('.block');
                    return block ? [...editor.children].indexOf(block) : -1;
                  };
                  const s = getSelection();
                  return [info(s.anchorNode), info(s.focusNode)];
                }"""
            )

        # 可见末尾之后没有合法光标位：右方向键直接落到下一块的可见起点。
        load(page, "- **乙**\n- 丙\n")
        caret(page, 0, len("- **乙"))
        page.keyboard.press("ArrowRight")
        page.wait_for_timeout(80)
        page.keyboard.insert_text("甲")
        page.wait_for_timeout(120)
        assert markdown(page) == "- **乙**\n- 甲丙\n", markdown(page)
        cases.append("块尾右移：跳过闭合标记，落到下一块可见起点")

        # → 到末尾再按一次：先到下一块，再进入下一块的第一个可见字符之间。
        load(page, "**粗体**\n\n下一段\n")
        caret(page, 0, len("**粗体"))
        page.keyboard.press("ArrowRight")
        page.keyboard.press("ArrowRight")
        page.wait_for_timeout(80)
        page.keyboard.insert_text("甲")
        page.wait_for_timeout(120)
        assert markdown(page) == "**粗体**\n\n甲下一段\n", markdown(page)
        cases.append("块尾右移两次：第二次进入下一块正文")

        # 已是最后一块：右方向键停在可见末尾，不落到闭合标记之后。
        load(page, "**粗体**")
        caret(page, 0, len("**粗体"))
        page.keyboard.press("ArrowRight")
        page.wait_for_timeout(80)
        page.keyboard.insert_text("尾")
        page.wait_for_timeout(120)
        assert markdown(page) == "**粗体尾**", ("last", markdown(page))
        cases.append("最后一块右移停在可见末尾")

        # Shift+→ 扩选同样不越过闭合标记：焦点收敛到下一块可见起点。
        load(page, "- **乙**\n- 丙\n")
        caret(page, 0, len("- **乙"))
        page.keyboard.press("Shift+ArrowRight")
        page.wait_for_timeout(120)
        assert selection_blocks() == [0, 1], selection_blocks()
        assert markdown(page) == "- **乙**\n- 丙\n", markdown(page)
        cases.append("块尾 Shift+→ 扩选不进入闭合标记")

        # 点击行尾：光标收敛到可见末尾，输入落在标记之前。
        load(page, "**粗体**\n")
        box = page.locator("#editor .block").first.bounding_box()
        page.mouse.click(box["x"] + box["width"] - 6, box["y"] + box["height"] / 2)
        page.wait_for_timeout(150)
        page.keyboard.insert_text("尾")
        page.wait_for_timeout(120)
        assert markdown(page) == "**粗体尾**\n", ("click", markdown(page))
        cases.append("点击行尾收敛到可见末尾")

        # 双击选词：选区只包含可见文字，不带上两侧标记。
        load(page, "**bold**\n")
        page.locator("#editor strong").dblclick()
        page.wait_for_timeout(150)
        assert page.evaluate("() => getSelection().toString()") == "bold"
        page.keyboard.insert_text("新")
        page.wait_for_timeout(120)
        assert markdown(page) == "**新**\n", ("dblclick", markdown(page))
        cases.append("双击选词不包含标记")

        # 块尾输入：追加在可见文字之后、闭合标记之前，可撤销。
        load(page, "**粗体**\n")
        caret(page, 0, len("**粗体"))
        page.keyboard.insert_text("尾")
        page.wait_for_timeout(120)
        assert markdown(page) == "**粗体尾**\n", ("type", markdown(page))
        page.keyboard.press("Control+z")
        page.wait_for_timeout(120)
        assert markdown(page) == "**粗体**\n", ("undo", markdown(page))
        cases.append("块尾输入落在闭合标记之前，可撤销")

        # 块尾粘贴：同样插在闭合标记之前。
        load(page, "**粗体**\n")
        caret(page, 0, len("**粗体"))
        page.evaluate(
            r"""() => {
              const d = new DataTransfer();
              d.setData('text/plain', '加');
              document.getElementById('editor').dispatchEvent(
                new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: d })
              );
            }"""
        )
        page.wait_for_timeout(120)
        assert markdown(page) == "**粗体加**\n", ("paste", markdown(page))
        cases.append("块尾粘贴落在闭合标记之前")

        # 块尾退格：删掉最后一个可见字符，标记原样保留。
        load(page, "**粗体**\n")
        caret(page, 0, len("**粗体"))
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "**粗**\n", ("backspace", markdown(page))
        cases.append("块尾退格不碰标记")

        # 块尾 Delete：右侧紧跟闭合标记时与退格对称解包，一步可撤销。
        load(page, "**粗体**\n")
        caret(page, 0, len("**粗体"))
        page.keyboard.press("Delete")
        page.wait_for_timeout(120)
        assert markdown(page) == "粗体\n", ("delete", markdown(page))
        page.keyboard.press("Control+z")
        page.wait_for_timeout(120)
        assert markdown(page) == "**粗体**\n", ("delete undo", markdown(page))
        cases.append("块尾 Delete 解包，一步可撤销")

        # Delete 解包一次只解一层：外层链接、内层粗体。
        load(page, "[**粗**](https://example.com)\n")
        caret(page, 0, len("[**粗"))
        page.keyboard.press("Delete")
        page.wait_for_timeout(120)
        assert markdown(page) == "[粗](https://example.com)\n", ("nested", markdown(page))
        page.keyboard.press("Delete")
        page.wait_for_timeout(120)
        assert markdown(page) == "粗\n", ("nested 2", markdown(page))
        cases.append("块尾 Delete 解包一次解一层")

        # 可见末尾之后没有闭合标记时，Delete 仍是普通删除（这里走块合并）。
        load(page, "甲乙\n\n下一段\n")
        caret(page, 0, len("甲乙"))
        page.keyboard.press("Delete")
        page.wait_for_timeout(120)
        assert markdown(page) == "甲乙\n下一段\n", ("plain", markdown(page))
        cases.append("可见末尾无闭合标记时 Delete 为普通删除")

        # 光标不在可见文字的边界时仍是普通删除，不触发解包。
        load(page, "**粗体**\n")
        caret(page, 0, len("**粗"))
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "**体**\n", markdown(page)
        load(page, "**粗体**\n")
        caret(page, 0, len("**粗"))
        page.keyboard.press("Delete")
        page.wait_for_timeout(120)
        assert markdown(page) == "**粗**\n", ("delete", markdown(page))
        cases.append("行内解包：光标不在边界时不触发")

        # 嵌套一次只解一层：外层链接、内层粗体，各按一次。
        load(page, "[**粗**](https://example.com)\n")
        caret(page, 0, len("[**"))
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "[粗](https://example.com)\n", markdown(page)
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "粗\n", markdown(page)
        cases.append("行内解包：嵌套标记一次解一层")

        # 块级前缀不受影响：先解行内粗体，再按一次才降级为正文。
        load(page, "## **粗体**\n")
        caret(page, 0, len("## **"))
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "## 粗体\n", markdown(page)
        page.keyboard.press("Backspace")
        page.wait_for_timeout(120)
        assert markdown(page) == "粗体\n", markdown(page)
        cases.append("行内解包不触碰块级前缀")

        load(page, "AT&amp;T\n===")
        blur(page)
        assert "AT&T" in page.locator("#editor .heading .block-preview").inner_text()
        assert page.locator("#editor .block-preview hr").count() == 0
        assert markdown(page) == "AT&amp;T\n==="
        cases.append("含实体的 Setext 走富块路径")
        print("PASS", cases[-1], flush=True)

        # --- indented code ---
        raw = "    const x = 1;\n    const y = 2;\n"
        load(page, raw)
        blur(page)
        assert page.locator("#editor .code .block-preview pre").inner_text().strip().startswith("const x = 1;")
        page.locator("#editor .code .block-preview").click()
        assert page.locator("#editor .code .block-source").is_visible()
        assert markdown(page) == raw
        cases.append("缩进代码块预览、编辑与 round-trip")
        print("PASS", cases[-1], flush=True)

        # --- bare URLs ---
        raw = "see https://example.com/a."
        load(page, raw)
        blur(page)
        assert page.locator("#editor a[href='https://example.com/a']").count() == 1
        assert markdown(page) == raw
        cases.append("普通段落裸 URL 链接化")
        print("PASS", cases[-1], flush=True)

        raw = "| name | url |\n| --- | --- |\n| link | https://example.com |"
        load(page, raw)
        blur(page)
        assert page.locator(".block-preview table a[href='https://example.com']").count() == 1
        assert markdown(page) == raw
        cases.append("富块裸 URL 链接化")
        print("PASS", cases[-1], flush=True)

        raw = (
            "| name | url |\n"
            "| --- | --- |\n"
            "| ftp | ftp://example.com/x |\n"
            "| protocol | //example.com/x |\n"
            "| fuzzy | www.example.com |\n"
            "| email | team@example.com |\n"
        )
        load(page, raw)
        blur(page)
        assert page.locator(".block-preview table a").count() == 0
        assert markdown(page) == raw
        cases.append("富块仅链接化 http/https/mailto")
        print("PASS", cases[-1], flush=True)

        raw = "（https://example.com）后文"
        load(page, raw)
        blur(page)
        assert page.locator("#editor a").count() == 1
        assert page.locator("#editor a[href='https://example.com']").count() == 1
        assert markdown(page) == raw
        cases.append("全角括号不并入裸 URL")
        print("PASS", cases[-1], flush=True)

        page.set_viewport_size({"width": 393, "height": 844})
        assert page.evaluate("() => document.documentElement.scrollWidth <= innerWidth")
        page.locator("#theme-toggle").click()
        assert page.locator("html").get_attribute("data-theme") == "dark"
        cases.append("移动端无横向溢出与深色主题")
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
