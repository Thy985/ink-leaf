from pathlib import Path
import os
from playwright.sync_api import sync_playwright
import json
ROOT=Path(__file__).resolve().parents[2] / 'test-results' / 'web'
ROOT.mkdir(parents=True, exist_ok=True)
cases=[]
def ok(name): cases.append(name); print('PASS',name,flush=True)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
 page=b.new_page(viewport={'width':1440,'height':1040},accept_downloads=True)
 errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('dialog',lambda d:d.accept())
 page.goto(os.environ.get('INKSTONE_WEB_URL', 'http://127.0.0.1:4173/'));page.wait_for_function('Boolean(window.inkstone)')
 def md():return page.evaluate('inkstone.getMarkdown()')
 def load(raw):
  page.locator('#file-input').set_input_files({'name':'测试.md','mimeType':'text/markdown','buffer':raw.encode()})
  page.wait_for_function('(x)=>inkstone.getMarkdown()===x',arg=raw)
 def blur():page.locator('#status').click();page.wait_for_timeout(30)
 def caret(index=0,offset=None):
  page.evaluate('''({index,offset})=>{const el=document.querySelector('#editor').children[index]; const pos=inkstone.getBlocks().slice(0,index).reduce((n,b)=>n+b.raw.length+1,0); document.querySelector('#editor').focus(); el.classList.add('active'); const raw=el.querySelector('.block-source')||el;let left=offset??inkstone.getBlocks()[index].raw.length;const w=document.createTreeWalker(raw,NodeFilter.SHOW_TEXT);let n,last;while(n=w.nextNode()){last=n;if(left<=n.length){getSelection().setBaseAndExtent(n,left,n,left);return;}left-=n.length;}getSelection().setBaseAndExtent(raw,0,raw,0);}''',{'index':index,'offset':offset})
  page.wait_for_timeout(25)
 table='| Left | Center | Right |\n| :--- | :---: | ---: |\n| **bold** | a\\|b | $x^2$ |'
 load(table);blur()
 assert page.locator('.block-preview table').count()==1
 assert page.locator('.block-preview th').nth(1).get_attribute('align')=='center'
 assert page.locator('.block-preview th').nth(2).get_attribute('align')=='right'
 assert page.locator('.block-preview td').nth(1).inner_text()=='a|b'
 assert page.locator('.block-preview strong').inner_text()=='bold'
 assert page.locator('.block-preview .katex').count()==1
 assert md()==table
 ok('GFM 表格、三种对齐、行内格式、转义管道与单元格公式')
 page.locator('.block-preview table').click();page.keyboard.press('Control+End');page.keyboard.insert_text('!')
 assert md().endswith('!'),repr(md());blur()
 assert page.locator('.block-preview table').count()==1
 ok('点击表格进入源码、输入与失焦预览原文不污染')
 load(table);caret(0,len(table));page.keyboard.press('Enter')
 assert md().endswith('\n|   |   |   |'),repr(md())
 page.keyboard.press('Control+z');assert md()==table
 caret(0,2);page.keyboard.press('Tab');page.keyboard.insert_text('NEW')
 assert '|NEW' in md(),repr(md())
 ok('表格 Enter 续行、Tab 跳格、撤销')
 load('---\n\n***\n\n___');blur();assert page.locator('.block-preview hr').count()==3
 ok('三种水平分割线')
 raw=r'\*literal\* \# heading \[link\] AT&amp;T &lt;b&gt;'
 load(raw);blur();assert page.locator('.block-preview em').count()==0
 assert '*literal* # heading [link] AT&T <b>' in page.locator('.block-preview').inner_text()
 caret(0,len(raw));page.keyboard.type('!');assert md()==raw+'!'
 ok('反斜杠转义与 HTML 实体显示及无损编辑')
 raw='<details>\n<summary>展开</summary>\n<p><mark>highlight</mark> X<sup>2</sup></p>\n</details>'
 load(raw);blur();page.locator('.block-preview summary').click();assert page.locator('.block-preview details').get_attribute('open') is not None
 assert page.locator('.block-preview mark').inner_text()=='highlight';assert md()==raw
 ok('HTML details 可展开及 mark/sup 安全排版')
 raw='<div id="editor" class="syntax" style="position:fixed" onclick="window.BAD=1"><script>window.BAD=1</script><img src="https://bad.invalid/a" onerror="window.BAD=2"><iframe src="https://bad.invalid"></iframe><a href="javascript:alert(1)">bad</a><p>safe</p></div>'
 load(raw);blur()
 assert not page.evaluate('Boolean(window.BAD)')
 assert page.locator('.block-preview script,.block-preview img,.block-preview iframe,.block-preview [onclick],.block-preview [style],.block-preview [id],.block-preview [class]').count()==0
 assert page.locator('.block-preview a').get_attribute('href') is None
 assert md()==raw
 ok('HTML 脚本、事件、嵌入、CSS、DOM clobbering 和危险 URL 过滤')
 raw=r'Inline $\frac{1}{2}$ and \(x^2\)'+'\n\n$$\n\\int_0^1 x^2\\,dx=\\frac{1}{3}\n$$\n\n\\[\\sum_{i=1}^n i\\]'
 load(raw);blur();assert page.locator('.block-preview .katex').count()==4
 assert page.locator('.katex-display').count()==2;assert md()==raw
 ok('美元与反斜杠两套行内/块级 LaTeX 公式')
 load('$$\\badcommand{1}$$');blur();assert page.locator('.math-error').count()==1
 assert md()=='$$\\badcommand{1}$$'
 ok('无效公式可读回退且编辑器不中断')
 raw='- parent\n  - child\n    1. ordered\n  - [x] nested task'
 load(raw);blur();assert page.locator('.list').count()==4
 assert page.locator('.list').nth(1).evaluate('(e)=>getComputedStyle(e).marginLeft')=='22px'
 page.locator('.task-box').click();assert md().endswith('- [ ] nested task')
 ok('混合嵌套列表缩进与嵌套任务勾选')
 load('- parent\n    - [ ] compute $x^2$');blur()
 assert page.locator('.block-preview .katex').count()==1
 page.locator('.task-box').click();assert md()=='- parent\n    - [x] compute $x^2$'
 ok('深层任务列表中的公式和勾选可混用')
 load('- parent\n- child');caret(1);page.keyboard.press('Tab');assert md()=='- parent\n  - child',repr(md())
 page.keyboard.press('Enter');page.keyboard.type('next');assert md().endswith('\n  - next')
 page.keyboard.press('Enter');page.keyboard.press('Enter');assert md().endswith('\n- '),repr(md())
 page.keyboard.press('Enter');assert md().endswith('\n'),repr(md())
 ok('Tab 列表缩进、保留层级续行、空项逐级退出')
 load('  9) item');caret();page.keyboard.press('Enter');page.keyboard.type('next');assert md()=='  9) item\n  10) next'
 page.keyboard.press('Shift+Tab');assert md()=='  9) item\n10) next'
 ok('嵌套有序列表续号与 Shift+Tab 退级')
 for cmd,kind in [('table','table'),('hr','hr'),('math','math'),('html','html')]:
  load('');caret();page.locator(f'[data-command="{cmd}"]').click();assert page.locator(f'#editor .{kind}').count()==1
 ok('四类新增工具栏插入')
 raw=table+'\n\n'+r'$$x^2$$'+'\n\n  - nested\n\n<div><b>safe</b></div>'
 load(raw);page.locator('#source-toggle').click();assert page.locator('#source').input_value()==raw
 page.locator('#source-toggle').click()
 with page.expect_download() as event:page.locator('#save').click()
 file=ROOT/'advanced-export.md';event.value.save_as(file);assert file.read_text()==raw;file.unlink()
 ok('复杂语法源码切换与下载逐字一致')
 page.wait_for_timeout(350);page.reload();page.wait_for_function('Boolean(window.inkstone)');assert md()==raw
 ok('复杂文档本地持久化恢复')
 page.set_viewport_size({'width':390,'height':844});blur();assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
 page.locator('#theme-toggle').click();assert page.locator('html').get_attribute('data-theme')=='dark'
 ok('手机布局与深色模式')
 assert not errors,errors
 b.close()
(ROOT/'advanced-results.json').write_text(json.dumps({'passed':len(cases),'cases':cases,'pageErrors':errors},ensure_ascii=False,indent=2)+'\n')
print('ALL PASS',len(cases))
