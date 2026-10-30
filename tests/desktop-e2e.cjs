'use strict';
const {_electron: electron} = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..');
const OUT=path.join(ROOT,'test-results');
const cases=[];
const ok=(s)=>{cases.push(s);console.log('PASS',s);};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFile(p,ms=10000){const t0=Date.now();while(Date.now()-t0<ms){try{const s=await fs.stat(p);if(s.size>0)return s;}catch{}await delay(150);}throw new Error('file not written: '+p);}
function crc32(buf){let t=crc32.t;if(!t){t=crc32.t=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c;}}let c=-1;for(let i=0;i<buf.length;i++)c=t[(c^buf[i])&0xff]^(c>>>8);return(c^-1)>>>0;}
function pngChunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,'latin1'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([len,body,crc]);}
// A random-noise PNG that DEFLATE cannot shrink, so embedded-image size assertions stay meaningful.
function noisePng(width,height){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;const raw=[];const row=Buffer.alloc(1+width*3);for(let y=0;y<height;y++){for(let x=0;x<width*3;x++)row[1+x]=(Math.random()*256)|0;raw.push(Buffer.from(row));}return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),pngChunk('IHDR',ihdr),pngChunk('IDAT',zlib.deflateSync(Buffer.concat(raw))),pngChunk('IEND',Buffer.alloc(0))]);}
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
 async function pasteImages(specs){await page.evaluate((specs)=>{const dt=new DataTransfer();for(const s of specs){let arr;if(s.b64){const bin=atob(s.b64);arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);}else arr=new Uint8Array(s.zeros);dt.items.add(new File([arr],'shot.png',{type:'image/png'}));}const ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true});Object.defineProperty(ev,'clipboardData',{value:dt});document.getElementById('editor').dispatchEvent(ev);},specs);}
 try{
  await launch();
  assert((await md()).includes('Windows v0.7'));
  assert.equal(await page.evaluate(()=>typeof require),'undefined');
  assert.equal(await page.evaluate(()=>typeof process),'undefined');
  const prefs=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
  ok('离线启动与隔离沙箱，渲染层无 Node 权限');
  assert.equal(await page.locator('.block-preview table').count(),1);assert.equal(await page.locator('.katex').count(),2);
  ok('v0.5 表格与本地公式资源完整加载');
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
  const complex='# 墨页 · 只管落笔\n\n| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| **粗体** | a\\|b | $x^2$ |\n\n---\n\n- 父项\n  - [x] 子项\n\n$$\nE=mc^2\n$$\n\n<details>\n<summary>展开</summary>\n<p><mark>高亮</mark></p>\n</details>\n\n```js\nconst desktop = true;\n```\n\n段落里的出处[^1] 与 [文档][docs]\n\n[^1]: 来源一\n[docs]: https://example.com/docs\n';
  await edit(complex);await page.locator('#source-toggle').click();await page.locator('#status').click();
  assert.equal(await page.locator('.block-preview table').count(),1);assert.equal(await page.locator('.block-preview hr').count(),1);assert.equal(await page.locator('.katex').count(),2);assert.equal(await md(),complex);
  assert((await page.locator('.block-preview pre code .hljs-keyword').count()) >= 1);
  assert.equal(await page.locator('#editor sup.fn-ref a[href="#ink-fn-1"]').count(),1);
  assert.equal(await page.locator('#editor .footnote-def').count(),1);
  assert.equal(await page.locator('#editor .paragraph a[href="https://example.com/docs"]').count(),1);ok('复杂 Markdown 桌面实时预览与原文无损');
  // v0.6: local images resolve through the desktop bridge against the saved document's folder.
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=','base64');
  await fs.writeFile(path.join(fixtures,'猫.png'),png);
  await fs.writeFile(path.join(fixtures,'外部.png'),png);
  await fs.mkdir(path.join(fixtures,'子'));await fs.writeFile(path.join(fixtures,'子','深入.png'),png);
  const imageDoc='# 图集\n\n正文 $E=mc^2$。\n\n![猫](猫.png)\n\n![越界](../外部.png)\n\n![不存在](ghost.png)\n\n![子目录](子/深入.png)\n';
  await edit(imageDoc);await page.locator('#source-toggle').click();await page.locator('#status').click();
  await page.waitForSelector('#editor .ink-image-ready img');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#editor .ink-image-ready').count(),2);
  assert.equal(await page.evaluate(()=>document.querySelector('#editor .ink-image-ready img').naturalWidth),1);
  assert.equal(await page.locator('#editor .ink-image[data-ink-state="error"]').count(),2);
  assert((await page.locator('#editor .ink-image-error .ink-image-note').first().textContent()).includes('文档目录内'));
  assert((await page.locator('#editor .ink-image-error .ink-image-note').nth(1).textContent()).includes('找不到'));
  await assertMD(imageDoc);ok('本地图片经桥接读取，越界与缺失被拒绝');
  const exported=path.join(fixtures,'导出.html');
  await queue('save',{canceled:false,filePath:exported});
  await cmd('exportHtml');
  await page.waitForTimeout(400);
  const html=await fs.readFile(exported,'utf8');
  assert(html.startsWith('<!doctype html>'));
  assert(html.includes('<title>图集</title>'));
  assert(html.includes('<math'), 'formulas export as MathML');
  assert(html.includes('data:image/png;base64,'),'cached local images embed as data URLs');
  assert(html.includes('ink-export-missing'),'unresolved images stay visible placeholders');
  ok('菜单导出 HTML 生成离线单文件');
  // v0.7: pasting a screenshot writes it beside the saved document and renders it.
  await page.locator('#editor .rich-block').first().click();
  await page.evaluate((bytes) => {
    const bin = atob(bytes);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    document.getElementById('editor').dispatchEvent(ev);
  }, png.toString('base64'));
  await delay(400);
  const inserted = (await fs.readdir(fixtures)).find((n) => /^粘贴图片-\d{8}-\d{6}(-\d+)?\.png$/.test(n));
  assert(inserted, 'clipboard image written beside the document');
  assert.equal((await fs.readFile(path.join(fixtures, inserted))).subarray(1, 4).toString('latin1'), 'PNG');
  assert((await md()).includes(`![粘贴图片](${inserted})`), 'markdown gains a relative image reference');
  await page.locator('#status').click();
  await page.waitForSelector('#editor .ink-image-ready img');
  ok('截图粘贴落盘到文档目录并显示');
  // v0.7: exporting PDF reuses the offline HTML pipeline and writes real PDF bytes.
  const exportedPdf = path.join(fixtures, '导出.pdf');
  await queue('save', {canceled:false, filePath: exportedPdf});
  await cmd('exportPdf');
  await waitFile(exportedPdf).catch(async (error) => {
    throw new Error(error.message + ' | toast: ' + await page.locator('#toast').textContent());
  });
  const pdfBytes = await fs.readFile(exportedPdf);
  assert.equal(pdfBytes.subarray(0, 5).toString('latin1'), '%PDF-');
  ok('菜单导出 PDF 生成公式内嵌的离线 PDF');
  // v0.8: a multi-image paste writes every file and inserts them as one undoable step.
  await edit('# 多图\n\n段落\n');await page.locator('#source-toggle').click();await page.locator('#editor > *').first().click();
  await pasteImages([{b64:png.toString('base64')},{b64:png.toString('base64')}]);
  await page.waitForFunction(()=>(window.inkstone.getMarkdown().match(/!\[粘贴图片\]\(粘贴图片-\d{8}-\d{6}(-\d+)?\.png\)/g)||[]).length===2);
  const shots=(await fs.readdir(fixtures)).filter((n)=>/^粘贴图片-\d{8}-\d{6}(-\d+)?\.png$/.test(n));
  assert.equal(shots.length,3,'two more images written beside the document');
  await page.locator('#status').click();
  await page.waitForSelector('#editor .ink-image-ready img');
  assert.equal(await page.locator('#editor .ink-image-ready img').count(),2);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>!window.inkstone.getMarkdown().includes('![粘贴图片]('));
  ok('多图一次粘贴全部落盘并整体撤销');
  // v0.8: paste failure paths keep the document intact and explain themselves.
  await queue('message',1);await cmd('new');await page.locator('#editor > *').first().click();
  await pasteImages([{b64:png.toString('base64')}]);
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('请先保存文档'));
  await assertMD('');
  ok('未保存文档时粘贴图片被拦截并提示');
  await open(first);await page.locator('#editor > *').first().click();
  await pasteImages([{zeros:5*1024*1024+1}]);
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('图片超过 5 MB'));
  await assertMD('# 修改后\n本地内容\n');
  await pasteImages([{b64:Buffer.from([1,2,3,4]).toString('base64')}]);
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('图片内容与类型不一致'));
  await assertMD('# 修改后\n本地内容\n');
  ok('超大与伪装图片粘贴给出明确拒绝文案');
  // v0.8: exports embed local images even when the editor never loaded them (C1) —
  // the image failed at open time, the file is added afterwards, and the export
  // reads it through the bridge without touching the editor's failed cards.
  const missingDoc='# 缺图\n\n![后补](后补.png)\n\n![幽灵](ghost.png)\n';
  const missingPath=path.join(fixtures,'缺图.md');await fs.writeFile(missingPath,missingDoc);
  await open(missingPath);
  await page.waitForSelector('#editor .ink-image[data-ink-state="error"]');
  assert.equal(await page.locator('#editor .ink-image[data-ink-state="error"]').count(),2);
  await fs.writeFile(path.join(fixtures,'后补.png'),noisePng(400,400));
  const missingHtmlPath=path.join(fixtures,'缺图导出.html');
  await queue('save',{canceled:false,filePath:missingHtmlPath});
  await cmd('exportHtml');
  await waitFile(missingHtmlPath);
  const missingHtml=await fs.readFile(missingHtmlPath,'utf8');
  assert(/data:image\/png;base64,[A-Za-z0-9+/=]{400000}/.test(missingHtml),'repaired local image embeds automatically at full size');
  assert(missingHtml.includes('ink-export-missing')&&missingHtml.includes('ghost.png'),'still-missing images keep a named placeholder');
  assert.equal(await page.locator('#editor .ink-image[data-ink-state="error"]').count(),2,'export does not touch editor card states');
  const missingPdfPath=path.join(fixtures,'缺图导出.pdf');
  await queue('save',{canceled:false,filePath:missingPdfPath});
  await cmd('exportPdf');
  await waitFile(missingPdfPath);
  const missingPdf=await fs.readFile(missingPdfPath);
  assert.equal(missingPdf.subarray(0,5).toString('latin1'),'%PDF-');
  assert(missingPdf.length>100000,'PDF carries the embedded image, far above a text-only baseline');
  ok('导出自动内嵌未加载的本地图片，编辑器状态不受影响');
  // v0.8: a long document (C3) exports to a multi-page PDF kept under test-results for
  // manual pagination review; the status line shows progress (C2) and the toast (C4)
  // carries the full output path.
  const longQuote='> '+'这是一段很长的引用文字，用来检查引用块在分页时不会被拦腰截断。'.repeat(30)+'\n';
  let longTable='| 列一 | 列二 | 列三 |\n| :--- | :---: | ---: |\n';
  for(let i=1;i<=60;i++)longTable+=`| 行 ${i} | 数据 ${(i*7)%100} | ${i%3===0?'**加粗**':'普通'} |\n`;
  let longCode='```js\n';
  for(let i=1;i<=300;i++)longCode+=`const step${i} = { index: ${i}, note: '第 ${i} 步的说明' };\n`;
  longCode+='```\n';
  const longDoc=`# 长文档排版样例\n\n${longQuote}\n${longTable}\n${longCode}\n结尾段落，确认文档完整收束。\n`;
  const longPath=path.join(fixtures,'长文.md');await fs.writeFile(longPath,longDoc);
  await open(longPath);
  await fs.mkdir(path.join(OUT,'desktop'),{recursive:true});
  const longPdfPath=path.join(OUT,'desktop','long-doc.pdf');
  await queue('save',{canceled:false,filePath:longPdfPath});
  await cmd('exportPdf');
  assert((await page.locator('#status').textContent()).includes('正在导出'),'status shows progress while printing');
  await waitFile(longPdfPath,60000);
  const longPdf=await fs.readFile(longPdfPath);
  assert.equal(longPdf.subarray(0,5).toString('latin1'),'%PDF-');
  assert(longPdf.length>50000,'long document yields a substantial multi-page PDF');
  await page.waitForFunction(()=>{const t=document.getElementById('toast').textContent;return t.includes('.pdf')&&(t.includes('\\')||t.includes('/'));});
  ok('长文档导出多页 PDF，导出中显示进度，完成后提示完整路径');
  await edit('<div onclick="window.BAD=1"><script>window.BAD=1</script><iframe src="https://bad.invalid"></iframe><a href="javascript:alert(1)">bad</a><p>safe</p></div>');await page.locator('#source-toggle').click();await page.locator('#status').click();
  assert.equal(await page.evaluate(()=>Boolean(window.BAD)),false);assert.equal(await page.locator('.block-preview script,.block-preview iframe,.block-preview [onclick]').count(),0);ok('HTML 脚本、事件、嵌入与危险链接过滤');
  await edit('alpha alpha');await cmd('find');await page.locator('#find-input').fill('alpha');assert.equal(await page.locator('#find-count').textContent(),'1 / 2');await page.locator('#replace-input').fill('beta');await page.locator('#replace-all').click();await assertMD('beta beta');await page.locator('#find-close').click();await cmd('undo');await assertMD('alpha alpha');await cmd('redo');await assertMD('beta beta');ok('原生菜单查找替换、撤销与重做');
  await cmd('source');assert(await page.locator('#source').isHidden());await cmd('source');assert(await page.locator('#source').isVisible());await cmd('theme');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await cmd('theme');await cmd('focus');assert(await page.locator('body').evaluate(e=>e.classList.contains('focus-mode')));await page.keyboard.press('Escape');ok('源文、主题、专注模式与 Esc');
  const recoveryText='# 崩溃恢复\n尚未写入文件的内容';await edit(recoveryText);await delay(700);
  const rec=JSON.parse(await fs.readFile(path.join(user,'recovery.json'),'utf8'));assert.equal(rec.text,recoveryText);ok('未保存文档自动写入本地恢复草稿');
  const proc=app.process();// Windows kill() only terminates the main process; lingering GPU/utility children keep the single-instance lock and block the relaunch, so kill the whole tree.
  if(process.platform==='win32')require('node:child_process').execFileSync('taskkill',['/PID',String(proc.pid),'/T','/F'],{stdio:'ignore'});else proc.kill('SIGKILL');await delay(800);await launch();await assertMD(recoveryText);ok('模拟崩溃后恢复未保存文字');
  await queue('message',2);await cmd('close');assert.equal(await page.locator('#source-toggle').count(),1);ok('关闭窗口选择取消可继续编辑');
  await edit(complex);if(await page.locator('#source').isVisible())await page.locator('#source-toggle').click();await page.locator('#status').click();await page.waitForTimeout(2600);await page.screenshot({path:path.join(OUT,'墨页-Windows桌面预览.png')});
  await queue('message',1);await cmd('close');await delay(500);await assert.rejects(fs.access(path.join(user,'recovery.json')));ok('关闭明确不保存后不再复活丢弃草稿');
  assert.deepEqual(errors,[]);ok('Electron 渲染无脚本异常');
  const result={passed:cases.length,cases,errors,platform:process.platform,note:'Electron Linux runtime integration test; Windows x64 artifacts are cross-built. Native Windows IME and installer smoke tests remain.'};
  await fs.writeFile(path.join(OUT,'desktop-e2e.json'),JSON.stringify(result,null,2));console.log('ALL PASS',cases.length);
 }catch(error){await fs.writeFile(path.join(OUT,'desktop-e2e-failure.txt'),String(error.stack));if(page&&!page.isClosed())await page.screenshot({path:path.join(OUT,'failure.png')});throw error;}
 finally{if(app)try{app.process().kill('SIGKILL');}catch{}}
})().catch(e=>{console.error(e);process.exit(1);});
