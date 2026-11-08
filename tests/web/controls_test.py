"""CSP-safe controls regression: no string wait_for_function / string evaluate.

Renaming and replace are observed through DOM locators and the app's
``body[data-ink-md]`` mirror (read via ``page.evaluate``), so the strict
production CSP without ``unsafe-eval`` never sees a string-compiled script.
"""
import os
import time

from playwright.sync_api import sync_playwright
from inktest import app_ready, load, markdown_settled

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
    x = b.new_page()
    errs = []
    x.on('pageerror', lambda e: errs.append(str(e)))
    x.on('dialog', lambda d: d.accept())
    x.goto(os.environ.get('INKSTONE_WEB_URL', 'http://127.0.0.1:4173/'))
    app_ready(x)
    x.locator('#rename').click()
    x.locator('#name-input').fill('v03验证.md')
    x.locator('#name-dialog button[value=confirm]').click()
    # Wait on the DOM, not a string-compiled expression: CSP-safe.
    deadline = time.monotonic() + 30
    while x.locator('#filename').inner_text() != 'v03验证.md':
        if time.monotonic() > deadline:
            raise TimeoutError('filename did not update to v03验证.md')
        time.sleep(0.05)
    print('PASS 重命名', flush=True)
    x.locator('#new').click()
    x.locator('#name-input').fill('新页')
    x.locator('#name-dialog button[value=confirm]').click()
    load(x, '', name='新页.md')
    print('PASS 新建', flush=True)
    x.locator('#source-toggle').click()
    x.locator('#source').fill('alpha alpha')
    x.locator('#find-toggle').click()
    x.locator('#find-input').fill('alpha')
    x.locator('#replace-input').fill('beta')
    x.locator('#replace-all').click()
    markdown_settled(x, 'beta beta')
    print('PASS 查找替换', flush=True)
    assert not errs, errs
    b.close()
