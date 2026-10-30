"""Run with python3 smoke_test.py; requires an existing local server and Playwright."""
from pathlib import Path
import json
import os
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2] / 'test-results' / 'web'
ROOT.mkdir(parents=True, exist_ok=True)
results = []

def ok(name):
    results.append(name)
    print('PASS', name, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
    page = browser.new_page(viewport={"width": 1440, "height": 1040}, accept_downloads=True)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.goto(os.environ.get('INKSTONE_WEB_URL', 'http://127.0.0.1:4173/'))
    page.wait_for_function('Boolean(window.inkstone)')

    def markdown():
        return page.evaluate('window.inkstone.getMarkdown()')

    def load(value, name='测试.md'):
        page.locator('#file-input').set_input_files({"name": name, "mimeType": "text/markdown", "buffer": value.encode('utf-8')})
        page.wait_for_function('(expected) => window.inkstone.getMarkdown() === expected', arg=value.replace('\r\n', '\n').replace('\r', '\n'))

    def caret(index=0, offset=None):
        page.evaluate('''({index, offset}) => {
          const editor = document.getElementById('editor');
          const el = editor.children[index];
          editor.focus();
          el.classList.add('active');
          const nodes=[]; const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
          let node; while(node=walker.nextNode()) nodes.push(node);
          let left=offset===null ? el.textContent.length : offset;
          let target=el, off=0;
          for (const n of nodes) { if(left<=n.length){target=n;off=left;break;} left-=n.length; }
          const selection=getSelection(); selection.setBaseAndExtent(target,off,target,off);
        }''', {"index": index, "offset": offset})

    original = '# 标题\n\n普通 **粗体** 与 *斜体*\n\n- 第一项\n\n> 引用\n\n```js\nconst x=1;\n```\n'
    load(original)
    assert page.locator('#editor .heading').count() == 1
    assert page.locator('#editor strong').inner_text() == '粗体'
    assert page.locator('#editor .code .block-preview').inner_text().strip() == 'const x=1;'
    assert markdown() == original
    ok('Markdown 打开与基础富文本渲染')

    load('')
    caret()
    page.keyboard.type('# ', delay=20)
    page.keyboard.insert_text('新标题')
    assert markdown() == '# 新标题', repr(markdown())
    assert page.locator('#editor .heading').count() == 1
    page.keyboard.press('Enter')
    page.keyboard.type('**bold**', delay=20)
    assert markdown() == '# 新标题\n\n**bold**', repr(markdown())
    assert page.locator('#editor strong').inner_text() == 'bold'
    ok('空文档起笔、标题和粗体的实时解析')

    page.keyboard.press('Control+a')
    page.keyboard.insert_text('全部替换')
    assert markdown() == '全部替换', repr(markdown())
    ok('跨块全选替换')

    load('hello')
    caret()
    page.keyboard.type(' world', delay=20)
    page.keyboard.insert_text('，你好')
    assert markdown() == 'hello world，你好', repr(markdown())
    assert page.evaluate('getSelection().anchorOffset') >= 1
    page.keyboard.type('!', delay=20)
    assert markdown() == 'hello world，你好!'
    ok('连续输入、中文文本与末尾光标稳定')

    load('段落')
    caret()
    page.keyboard.press('Enter')
    page.keyboard.insert_text('下一段')
    assert markdown() == '段落\n\n下一段', repr(markdown())
    page.keyboard.press('Control+z')
    assert markdown() == '段落\n\n'
    page.keyboard.press('Control+Shift+z')
    assert markdown() == '段落\n\n下一段'
    ok('分段、撤销与重做')

    load('- first')
    caret()
    page.keyboard.press('Enter')
    page.keyboard.type('second')
    assert markdown() == '- first\n- second', repr(markdown())
    page.keyboard.press('Enter')
    page.keyboard.press('Enter')
    assert markdown() == '- first\n- second\n', repr(markdown())
    page.keyboard.insert_text('普通段落')
    assert markdown().endswith('\n普通段落')
    ok('列表续行与空项退出')

    load('1. one')
    caret()
    page.keyboard.press('Enter')
    page.keyboard.type('two')
    assert markdown() == '1. one\n2. two'
    load('> quote')
    caret()
    page.keyboard.press('Enter')
    page.keyboard.type('next')
    assert markdown() == '> quote\n> next'
    ok('有序列表编号与引用续行')

    load('title')
    caret()
    page.locator('[data-command="h2"]').click()
    assert markdown() == '## title'
    assert page.locator('#editor .heading[data-level="2"]').count() == 1
    page.locator('[data-command="bold"]').click()
    assert markdown() == '## title**粗体文字**'
    page.keyboard.insert_text('重点')
    assert markdown() == '## title**重点**'
    page.keyboard.press('Control+b')
    ok('工具栏格式、快捷键与选中文本替换')

    load('before\n\nafter')
    caret(0, 6)
    page.keyboard.press('Delete')
    assert markdown() == 'before\nafter', repr(markdown())
    ok('块边界删除与模型合并')

    load('```js\nlet a = 1;\n```\n')
    caret(0, len('```js\nlet a = 1;'))
    page.keyboard.press('Enter')
    page.keyboard.type('let b = 2;')
    assert markdown() == '```js\nlet a = 1;\nlet b = 2;\n```\n', repr(markdown())
    assert page.locator('#editor .code').count() == 1
    ok('围栏代码块内换行与原文保留')

    load('组合')
    caret()
    composition = page.evaluate('''() => {
      const e=document.getElementById('editor'); const node=e.firstChild;
      e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
      node.firstChild.textContent += '输入';
      const end=node.firstChild.length; getSelection().setBaseAndExtent(node.firstChild,end,node.firstChild,end);
      e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'输入',isComposing:true}));
      const during={sameNode:node===e.firstChild,model:window.inkstone.getMarkdown(),composing:window.inkstone.isComposing};
      e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'输入'}));
      return during;
    }''')
    assert composition == {"sameNode": True, "model": "组合", "composing": True}
    assert markdown() == '组合输入'
    ok('模拟 IME 组合期间不重建 DOM，结束后写回模型')

    load('safe')
    caret()
    page.evaluate(r'''() => {
      const d=new DataTransfer(); d.setData('text/plain','\n\n<script>window.BAD=true</script>\n**粘贴**');
      document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));
    }''')
    assert markdown() == 'safe\n\n<script>window.BAD=true</script>\n**粘贴**'
    assert not page.evaluate('Boolean(window.BAD)')
    assert page.locator('#editor script').count() == 0
    ok('多行纯文本粘贴及 HTML 注入防护')

    load(original)
    page.locator('#source-toggle').click()
    assert page.locator('#source').input_value() == original
    page.locator('#source').fill('# 源码\n\n**保留**\n')
    assert markdown() == '# 源码\n\n**保留**\n'
    page.locator('#source-toggle').click()
    assert page.locator('#editor .heading').inner_text() == '源码'
    # Headless Chromium exposes the File System Access API but aborts real pickers, so stub a
    # writable handle and verify the FSA save path writes the same bytes a download would.
    page.evaluate('''() => {
      window.__savedFile = null;
      window.showSaveFilePicker = async (opts) => {
        const name = opts.suggestedName;
        return {
          kind: 'file', name,
          createWritable: async () => ({
            parts: [],
            async write(part) { this.parts.push(await part.text()); },
            async close() { window.__savedFile = { name, text: this.parts.join('') }; },
          }),
          getFile: async () => ({ name, size: 0 }),
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
        };
      };
    }''')
    page.locator('#save').click()
    for _ in range(50):
        if page.evaluate('Boolean(window.__savedFile)'): break
        page.wait_for_timeout(100)
    saved = page.evaluate('window.__savedFile')
    assert saved['name'] == '测试.md' and saved['text'] == '# 源码\n\n**保留**\n', saved
    ok('源码视图与 FSA 保存内容一致')

    page.wait_for_timeout(400)
    page.reload()
    page.wait_for_function('Boolean(window.inkstone)')
    assert markdown() == '# 源码\n\n**保留**\n'
    ok('浏览器本地草稿恢复')

    page.evaluate('localStorage.clear()')
    page.reload()
    page.wait_for_function('Boolean(window.inkstone)')
    page.wait_for_timeout(200)
    page.screenshot(path=str(ROOT / 'preview-desktop.png'), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(ROOT / 'preview-mobile.png'), full_page=True)
    ok('桌面/手机布局无水平溢出')
    assert not errors, errors
    browser.close()

(ROOT / 'test-results.json').write_text(json.dumps({"passed": len(results), "cases": results, "pageErrors": errors, "imeNote": "组合输入采用合成事件验证，未覆盖各操作系统真实输入法"}, ensure_ascii=False, indent=2) + '\n')
print(f'ALL PASS: {len(results)} cases', flush=True)
