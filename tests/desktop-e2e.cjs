'use strict';
const {_electron: electron} = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..');
const OUT=path.join(ROOT,'test-results');
const cases=[];
const ok=(s)=>{cases.push(s);console.log('PASS',s);};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 await fs.mkdir(OUT,{recursive:true});
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'inkstone-e2e-'));
 const user=path.join(temp,'userdata');
 const fixtures=path.join(temp,'files');await fs.mkdir(fixtures);
 let app,page; const errors=[];
 async function launch(){
  app=await electron.launch({args:['--no-sandbox',ROOT],env:{...process.env,INKSTONE_USER_DATA:user},timeout:30000});
  page=await app.firstWindow(); page.on('pageerror',e=>errors.push(String(e)));
  await page.waitForFunction(()=>Boolean(window.desktop && window.inkstone));
  await page.waitForTimeout(350);
  await app.evaluate(({dialog})=>{
   globalThis.__testDialogs={open:[],save:[],message:[]};
   dialog.showOpenDialog=async()=>globalThis.__testDialogs.open.shift()||{canceled:true,filePaths:[]};
   dialog.showSaveDialog=async()=>globalThis.__testDialogs.save.shift()||{canceled:true};
   dialog.showMessageBox=async()=>({response:globalThis.__testDialogs.message.shift()??2});
  });
 }
 async function queue(kind,result){await app.evaluate((_,{kind,result})=>globalThis.__testDialogs[kind].push(result),{kind,result});}
 async function cmd(action){await app.evaluate(({BrowserWindow},action)=>BrowserWindow.getAllWindows()[0].webContents.send('desktop:command',action),action);await delay(150);}
 async function md(){return page.evaluate(()=>window.inkstone.getMarkdown());}
 async function edit(value){if(await page.locator('#source').isHidden())await page.locator('#source-toggle').click();await page.locator('#source').fill(value);await delay(50);}
 async function open(p,discard=true){await queue('open',{canceled:false,filePaths:[p]});if(discard && await page.locator('#dirty').textContent())await queue('message',1);await cmd('open');}
 async function saveAs(p){await queue('save',{canceled:false,filePath:p});await cmd('saveAs');}
 async function assertMD(s){await page.waitForFunction(s=>window.inkstone.getMarkdown()===s,s);assert.equal(await md(),s);}
 try{
  await launch();
  assert((await md()).includes('Windows v0.4'));
  assert.equal(await page.evaluate(()=>typeof require),'undefined');
  assert.equal(await page.evaluate(()=>typeof process),'undefined');
  const prefs=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
  ok('离线启动与隔离沙箱，渲染层无 Node 权限');
  assert.equal(await page.locator('.block-preview table').count(),1);assert.equal(await page.locator('.katex').count(),2);
  ok('v0.4 表格与本地公式资源完整加载');
  await app.evaluate(({Menu})=>{
   const entries=Menu.getApplicationMenu().items.flatMap(i=>i.submenu?.items||[]);
   for(const accelerator of ['CommandOrControl+N','CommandOrControl+O','CommandOrControl+S','CommandOrControl+Shift+S','CommandOrControl+K'])if(!entries.some(i=>i.accelerator===accelerator))throw Error('Missing accelerator '+accelerator);
  });ok('Windows 原生菜单与文件/格式快捷键注册');
  const first=path.join(fixtures,'原稿.md');await fs.writeFile(first,'\ufeff# 本地文档\r\n正文\r\n');
  await open(first);await assertMD('# 本地文档\n正文\n');ok('原生打开对话框与中文文件名读取');
  await edit('# 修改后\n本地内容\n');await page.keyboard.press('Control+s');await delay(250);
  assert.equal(await fs.readFile(first,'utf8'),'\ufeff# 修改后\r\n本地内容\r\n');assert.equal(await page.locator('#dirty').textContent(),'');ok('Ctrl+S 同路径覆盖，保留 BOM / CRLF');
  const copy=path.join(fixtures,'另存为.md');await saveAs(copy);assert.equal(await fs.readFile(copy,'utf8'),'\ufeff# 修改后\r\n本地内容\r\n');ok('另存为创建新文件并切换保存目标');
  await edit('# 保留编辑');await cmd('saveAs');assert.equal(await md(),'# 保留编辑');assert.equal(await page.locator('#dirty').textContent(),'•');ok('取消另存为不清除未保存状态');
  await fs.writeFile(copy,'外部修改');await queue('message',2);await cmd('save');assert.equal(await fs.readFile(copy,'utf8'),'外部修改');ok('外部修改冲突选择取消，不覆盖磁盘内容');
  await queue('message',0);await cmd('save');assert((await fs.readFile(copy,'utf8')).includes('# 保留编辑'));ok('冲突明确选择覆盖后才写入');
  await edit('不能丢失的文字');await queue('message',2);await cmd('new');await assertMD('不能丢失的文字');ok('新建的未保存提醒可取消');
  const invalid=path.join(fixtures,'invalid.md');await fs.writeFile(invalid,Buffer.from([0xff,0xfe,0x31]));await open(invalid,false);await assertMD('不能丢失的文字');ok('非法 UTF-8 打开失败保留当前内容');
  await queue('message',1);await cmd('new');await assertMD('');ok('明确不保存后才新建空白文档');
  const clean=path.join(fixtures,'新建保存.md');await edit('# 新文件');await queue('save',{canceled:false,filePath:clean});await cmd('save');assert.equal(await fs.readFile(clean,'utf8'),'# 新文件');ok('未命名文档第一次保存弹系统保存框');
  const complex='# 墨页 · 只管落笔\n\n| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| **粗体** | a\\|b | $x^2$ |\n\n---\n\n- 父项\n  - [x] 子项\n\n$$\nE=mc^2\n$$\n\n<details>\n<summary>展开</summary>\n<p><mark>高亮</mark></p>\n</details>\n\n```js\nconst desktop = true;\n```\n';
  await edit(complex);await page.locator('#source-toggle').click();await page.locator('#status').click();
  assert.equal(await page.locator('.block-preview table').count(),1);assert.equal(await page.locator('.block-preview hr').count(),1);assert.equal(await page.locator('.katex').count(),2);assert.equal(await md(),complex);
  assert((await page.locator('.block-preview pre code .hljs-keyword').count()) >= 1);ok('复杂 Markdown 桌面实时预览与原文无损');
  await edit('<div onclick="window.BAD=1"><script>window.BAD=1</script><iframe src="https://bad.invalid"></iframe><a href="javascript:alert(1)">bad</a><p>safe</p></div>');await page.locator('#source-toggle').click();await page.locator('#status').click();
  assert.equal(await page.evaluate(()=>Boolean(window.BAD)),false);assert.equal(await page.locator('.block-preview script,.block-preview iframe,.block-preview [onclick]').count(),0);ok('HTML 脚本、事件、嵌入与危险链接过滤');
  await edit('alpha alpha');await cmd('find');await page.locator('#find-input').fill('alpha');assert.equal(await page.locator('#find-count').textContent(),'1 / 2');await page.locator('#replace-input').fill('beta');await page.locator('#replace-all').click();await assertMD('beta beta');await page.locator('#find-close').click();await cmd('undo');await assertMD('alpha alpha');await cmd('redo');await assertMD('beta beta');ok('原生菜单查找替换、撤销与重做');
  await cmd('source');assert(await page.locator('#source').isHidden());await cmd('source');assert(await page.locator('#source').isVisible());await cmd('theme');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await cmd('theme');await cmd('focus');assert(await page.locator('body').evaluate(e=>e.classList.contains('focus-mode')));await page.keyboard.press('Escape');ok('源文、主题、专注模式与 Esc');
  const recoveryText='# 崩溃恢复\n尚未写入文件的内容';await edit(recoveryText);await delay(700);
  const rec=JSON.parse(await fs.readFile(path.join(user,'recovery.json'),'utf8'));assert.equal(rec.text,recoveryText);ok('未保存文档自动写入本地恢复草稿');
  const proc=app.process();proc.kill('SIGKILL');await delay(800);await launch();await assertMD(recoveryText);ok('模拟崩溃后恢复未保存文字');
  await queue('message',2);await cmd('close');assert.equal(await page.locator('#source-toggle').count(),1);ok('关闭窗口选择取消可继续编辑');
  await edit(complex);if(await page.locator('#source').isVisible())await page.locator('#source-toggle').click();await page.locator('#status').click();await page.waitForTimeout(2600);await page.screenshot({path:path.join(OUT,'墨页-Windows桌面预览.png')});
  await queue('message',1);await cmd('close');await delay(500);await assert.rejects(fs.access(path.join(user,'recovery.json')));ok('关闭明确不保存后不再复活丢弃草稿');
  assert.deepEqual(errors,[]);ok('Electron 渲染无脚本异常');
  const result={passed:cases.length,cases,errors,platform:process.platform,note:'Electron Linux runtime integration test; Windows x64 artifacts are cross-built. Native Windows IME and installer smoke tests remain.'};
  await fs.writeFile(path.join(OUT,'desktop-e2e.json'),JSON.stringify(result,null,2));console.log('ALL PASS',cases.length);
 }catch(error){await fs.writeFile(path.join(OUT,'desktop-e2e-failure.txt'),String(error.stack));if(page&&!page.isClosed())await page.screenshot({path:path.join(OUT,'failure.png')});throw error;}
 finally{if(app)try{app.process().kill('SIGKILL');}catch{}}
})().catch(e=>{console.error(e);process.exit(1);});
