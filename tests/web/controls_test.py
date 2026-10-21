import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
 x=b.new_page();errs=[];x.on('pageerror',lambda e:errs.append(str(e)))
 x.on('dialog',lambda d:d.accept())
 x.goto(os.environ.get('INKSTONE_WEB_URL', 'http://127.0.0.1:4173/'));x.wait_for_function('window.inkstone')
 x.locator('#rename').click();x.locator('#name-input').fill('v03验证.md');x.locator('button[value=confirm]').click()
 x.wait_for_function('()=>document.querySelector("#filename").textContent==="v03验证.md"')
 print('PASS 重命名',flush=True)
 x.locator('#new').click();x.locator('#name-input').fill('新页');x.locator('button[value=confirm]').click()
 x.wait_for_function('()=>inkstone.getMarkdown()===""')
 print('PASS 新建',flush=True)
 x.locator('#source-toggle').click();x.locator('#source').fill('alpha alpha')
 x.locator('#find-toggle').click();x.locator('#find-input').fill('alpha');x.locator('#replace-input').fill('beta');x.locator('#replace-all').click()
 x.wait_for_function('()=>inkstone.getMarkdown()==="beta beta"')
 print('PASS 查找替换',flush=True)
 assert not errs,errs
 b.close()
