'use strict';
const {_electron:electron}=require('playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'inkstone-nativekeys-'));
 const app=await electron.launch({args:['--no-sandbox',root],env:{...process.env,INKSTONE_USER_DATA:dir}});
 try{
  const p=await app.firstWindow();await p.waitForFunction(()=>Boolean(window.inkstone));await p.waitForTimeout(400);
  await p.locator('#source-toggle').click();await p.locator('#source').fill('hello');await p.locator('#source').selectText();
  const id=execFileSync('xdotool',['search','--onlyvisible','--pid',String(app.process().pid)],{encoding:'utf8'}).trim().split('\n')[0];
  execFileSync('xdotool',['windowfocus','--sync',id]);
  async function key(k){execFileSync('xdotool',['key','--clearmodifiers',k]);await p.waitForTimeout(200);}
  async function md(){return p.evaluate(()=>window.inkstone.getMarkdown());}
  await key('ctrl+b');assert.equal(await md(),'**hello**');
  await key('ctrl+z');assert.equal(await md(),'hello');
  await key('ctrl+shift+z');assert.equal(await md(),'**hello**');
  await key('F8');assert(await p.locator('body').evaluate(e=>e.classList.contains('focus-mode')));
  await key('Escape');assert(!await p.locator('body').evaluate(e=>e.classList.contains('focus-mode')));
  const target=path.join(dir,'keyboard.md');
  await app.evaluate(({dialog},filePath)=>{globalThis.__saveCount=0;dialog.showSaveDialog=async()=>{globalThis.__saveCount++;return{canceled:false,filePath}};},target);
  await key('ctrl+s');assert.equal(await fs.readFile(target,'utf8'),'**hello**');assert.equal(await app.evaluate(()=>globalThis.__saveCount),1);
  await fs.mkdir(path.join(root,'test-results'),{recursive:true});
  await fs.writeFile(path.join(root,'test-results/native-keyboard.json'),JSON.stringify({passed:6,platform:process.platform,cases:['真实 Ctrl+B 只执行一次','真实 Ctrl+Z 撤销','真实 Ctrl+Shift+Z 重做','F8 专注','Esc 退出专注','真实 Ctrl+S 只保存一次']},null,2));
  console.log('ALL PASS: 6 native X11 keyboard checks');
 }finally{app.process().kill('SIGKILL');}
})().catch(e=>{console.error(e);process.exit(1)});
