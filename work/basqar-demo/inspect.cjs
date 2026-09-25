const { chromium } = require('/Users/ashat/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:1920,height:1080},locale:'ru-RU',timezoneId:'Asia/Almaty',deviceScaleFactor:1});
 const login=await context.request.post('http://127.0.0.1:4497/api/v1/auth/login',{data:{email:'owner@demo-agency.example',password:'DemoVideo2026!'}});
 console.log('LOGIN',login.status());
 const ids=JSON.parse(fs.readFileSync('work/basqar-demo/ids.json'));
 await context.addInitScript(id=>{localStorage.setItem('crm_tenant',id);localStorage.setItem('creolab.browserNotifications.bannerDismissed','1');},ids.tenantId);
 const page=await context.newPage();
 page.on('pageerror',e=>console.log('PAGE_ERROR',e.message));
 for(const name of ['documents/invoices/'+ids.invoiceId,'tasks','conversations/'+ids.conversationId]){
  await page.goto('http://127.0.0.1:4497/'+name);await page.waitForTimeout(2300);
  console.log(name,(await page.locator('body').innerText()).slice(0,9000));
  await page.screenshot({path:'work/basqar-demo/detail-'+name.split('/')[0].split('?')[0]+'.png'});
 }
 await context.storageState({path:'work/basqar-demo/auth.json'});
 await browser.close();
})();
