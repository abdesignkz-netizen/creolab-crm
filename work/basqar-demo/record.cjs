const {chromium}=require('/Users/ashat/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const base=path.resolve('outputs/basqar-flow-kit');
const ffmpeg=path.resolve('work/basqar-demo/python/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1');
const ids=JSON.parse(fs.readFileSync('work/basqar-demo/ids.json'));
for(const dir of ['clips','frames','assets'])fs.mkdirSync(path.join(base,dir),{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let browser,context,page;let mx=1730,my=170;
async function move(x,y,ms=650){const sx=mx,sy=my;for(let i=1;i<=30;i++){const t=i/30,e=t*t*(3-2*t);await page.mouse.move(sx+(x-sx)*e,sy+(y-sy)*e);await sleep(ms/30);}mx=x;my=y;}
async function click(loc){await loc.waitFor({state:'visible'});await loc.scrollIntoViewIfNeeded();const b=await loc.boundingBox();await move(b.x+b.width/2,b.y+b.height/2);await sleep(180);await page.mouse.click(mx,my);}
async function scrollTo(loc){await loc.evaluate(e=>e.scrollIntoView({behavior:'smooth',block:'center'}));await sleep(900);}
async function goto(route){await page.goto('http://127.0.0.1:4497/'+route);await page.waitForTimeout(1500);await page.evaluate(()=>document.fonts.ready);await page.mouse.move(1730,170);mx=1730;my=170;}
async function record(name,seconds,actions){
 console.log('RECORD',name);
 const cdp=await context.newCDPSession(page);let last=await page.screenshot({type:'jpeg',quality:95});
 const proc=spawn(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate','30','-vcodec','mjpeg','-i','pipe:0','-an','-c:v','libx264','-preset','veryfast','-crf','17','-pix_fmt','yuv420p','-movflags','+faststart',path.join(base,'clips',name+'.mp4')]);
 let errors='';proc.stderr.on('data',d=>errors+=d);const done=new Promise((res,rej)=>proc.on('exit',c=>c===0?res():rej(Error(errors))));
 cdp.on('Page.screencastFrame',async e=>{last=Buffer.from(e.data,'base64');await cdp.send('Page.screencastFrameAck',{sessionId:e.sessionId}).catch(()=>{});});
 await cdp.send('Page.startScreencast',{format:'jpeg',quality:95,maxWidth:1920,maxHeight:1080,everyNthFrame:1});
 await page.screenshot({path:path.join(base,'frames',name+'-start.png')});
 const start=Date.now();let count=0;const timer=setInterval(()=>{const target=Math.min(Math.floor((Date.now()-start)*30/1000)+1,seconds*30);while(count<target){proc.stdin.write(last);count++;}},16);
 try{await actions();await sleep(Math.max(0,seconds*1000-(Date.now()-start)));}
 catch(e){console.error('ACTION_FAILED',name,e.message);throw e;}
 finally{clearInterval(timer);while(count<seconds*30){proc.stdin.write(last);count++;}await cdp.send('Page.stopScreencast');await cdp.detach();proc.stdin.end();await done;}
 await page.screenshot({path:path.join(base,'frames',name+'-end.png')});console.log('SAVED',name,seconds);
}
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 context=await browser.newContext({viewport:{width:1920,height:1080},locale:'ru-RU',timezoneId:'Asia/Almaty',deviceScaleFactor:1});
 const login=await context.request.post('http://127.0.0.1:4497/api/v1/auth/login',{data:{email:'owner@demo-agency.example',password:'DemoVideo2026!'}});if(!login.ok())throw Error('Login failed');
 await context.addInitScript(id=>{localStorage.setItem('crm_tenant',id);localStorage.setItem('creolab.browserNotifications.bannerDismissed','1');
 window.addEventListener('DOMContentLoaded',()=>{const cursor=document.createElement('div');cursor.id='recording-cursor';cursor.style.cssText='position:fixed;left:0;top:0;width:30px;height:38px;z-index:2147483647;pointer-events:none;transform:translate(1730px,170px);filter:drop-shadow(0 2px 2px #0005)';cursor.innerHTML='<svg viewBox="0 0 30 38" width="30" height="38"><path d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 21 L27 21 Z" fill="#142744" stroke="white" stroke-width="2.4"/></svg>';document.body.append(cursor);window.addEventListener('mousemove',e=>cursor.style.transform=`translate(${e.clientX}px,${e.clientY}px)`);window.addEventListener('mousedown',()=>{cursor.style.filter='drop-shadow(0 0 9px #087fff)';});window.addEventListener('mouseup',()=>{cursor.style.filter='drop-shadow(0 2px 2px #0005)';});});
 },ids.tenantId);
 page=await context.newPage();page.setDefaultTimeout(8000);
 const only=process.argv[2];const chosen=n=>!only||only===n;
 if(chosen('01')){await goto('inquiries');await record('01-inquiries',12,async()=>{await sleep(1600);await click(page.getByRole('button',{name:/^Новые\s*3$/}));await sleep(2000);await click(page.locator('.request-row').filter({hasText:'Алина Нурланова'}));await sleep(1700);await move(985,570);});}
 if(chosen('02')){await goto('contacts/'+ids.contactId);await record('02-client-card',12,async()=>{await sleep(2300);await scrollTo(page.getByRole('button',{name:'История',exact:true}));await sleep(1000);await click(page.getByRole('button',{name:'Сделки',exact:true}));await sleep(1800);await click(page.getByRole('button',{name:'История',exact:true}));await move(1080,790);});}
 if(chosen('03')){await goto('conversations/'+ids.conversationId);await record('03-conversations',12,async()=>{await sleep(2600);await click(page.locator('.conv-row').filter({hasText:'Данияр Аскаров'}));await sleep(2700);await click(page.locator('.conv-row').filter({hasText:'Алина Нурланова'}));await sleep(600);await move(1425,560);});}
 if(chosen('04')){await goto('deals?view=board');await page.mouse.wheel(0,220);await sleep(800);await record('04-sales-pipeline',12,async()=>{await sleep(2200);const card=page.getByRole('button',{name:'Открыть сделку: Брендинг и фирменный стиль',exact:true});const from=await card.boundingBox();const to=await page.locator('.deal-column').filter({has:page.locator('.deal-column-head b',{hasText:/^В работе$/})}).boundingBox();await move(from.x+from.width/2,from.y+35);await page.mouse.down();await move(to.x+to.width/2,to.y+100,1200);await page.mouse.up();await sleep(2700);await move(1290,710);});}
 if(chosen('05')){await goto('tasks');const task=page.locator('.task-row').filter({hasText:'Согласовать бриф с Alma Interiors'}).first();await task.evaluate(e=>e.scrollIntoView({block:'start'}));await sleep(600);await record('05-tasks',12,async()=>{await sleep(1800);await click(task.getByRole('button',{name:'В работе',exact:true}));await sleep(2300);await click(task.getByRole('button',{name:'Изменить',exact:true}));await sleep(1800);await move(1440,665);});}
 if(chosen('06')){await goto('documents');await record('06-documents',14,async()=>{await sleep(1500);await click(page.getByRole('button',{name:/^Счета\s*6$/}));await sleep(1500);await click(page.getByRole('link',{name:'2026-001',exact:true}));await sleep(1400);await scrollTo(page.getByRole('heading',{name:'Позиции счёта',exact:true}));await sleep(1800);await move(1500,645);});}
 if(!only||only==='cta'){
  const svg=fs.readFileSync('apps/web/public/basqar-logo.svg');fs.copyFileSync('apps/web/public/basqar-logo.svg',path.join(base,'assets','basqar-logo.svg'));
  const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#f6f9ff;color:#15223c;width:1920px;height:1080px;overflow:hidden}.glow{position:absolute;width:900px;height:900px;border-radius:50%;background:radial-gradient(circle,#b1edff70,transparent 68%);top:-440px;right:-170px}.glow.b{top:550px;left:-230px;background:radial-gradient(circle,#c4ceff70,transparent 68%)}main{position:absolute;inset:0;display:flex;align-items:center;flex-direction:column;padding-top:190px}img{width:440px;height:auto}h1{font-size:76px;letter-spacing:-2.4px;margin:78px 0 24px;font-weight:700}p{font-size:28px;margin:0;color:#6b7a94}.cta{font-size:32px;font-weight:600;color:white;background:linear-gradient(110deg,#078bec,#315eff);padding:25px 55px;border-radius:18px;margin-top:52px;box-shadow:0 20px 50px #2c6bff25}.url{font-size:46px;font-weight:700;letter-spacing:1px;margin-top:31px;color:#172844}.rule{width:80px;height:5px;border-radius:5px;background:linear-gradient(90deg,#29cffb,#3659fb);margin-top:58px}main>*{animation:rise .85s ease both}h1{animation-delay:.12s}p{animation-delay:.24s}.cta{animation-delay:.36s}.url{animation-delay:.48s}@keyframes rise{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:translateY(0)}}</style><div class="glow"></div><div class="glow b"></div><main><img src="data:image/svg+xml;base64,${svg.toString('base64')}" alt="BasQar"><h1>От заявки — к результату.</h1><p>Клиенты, сделки и документы в одном месте</p><div class="cta">Попробовать бесплатно</div><div class="url">bsqr.kz</div><div class="rule"></div></main></html>`;
  fs.writeFileSync(path.join(base,'assets','cta.html'),html);await page.setContent(html);await sleep(1000);await page.screenshot({path:path.join(base,'assets','cta-1920x1080.png')});
  await page.evaluate(()=>document.querySelectorAll('main>*').forEach(e=>{e.style.animation='none'}));
  await record('07-cta',5,async()=>{});
 }
 await browser.close();console.log('ALL_DONE');
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exit(1)});
