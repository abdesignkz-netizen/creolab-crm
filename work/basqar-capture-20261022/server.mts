import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const base=path.resolve('work/basqar-capture-20261022');
mkdirSync(base,{recursive:true});
Object.assign(process.env,{
 NODE_ENV:'test',CRM_USE_PGLITE:'1',CRM_PGLITE_DIR:mkdtempSync(path.join(base,'db-')),DATABASE_URL:'',STORAGE_DIR:path.join(base,'uploads'),
 SEED_PASSWORD:'ScreenshotsLocal2026!',PLATFORM_ADMIN_EMAIL:'platform@basqar.example',PLATFORM_ADMIN_PASSWORD:'ScreenshotsLocal2026!',
 ENCRYPTION_KEY:'isolated-screenshot-fixture',BILLING_PROVIDER:'none',FREEDOM_PAY_MERCHANT_ID:'',FREEDOM_PAY_SECRET_KEY:'',AI_PROVIDER:'',TRANSCRIPTION_API_KEY:'',ESF_PROVIDER:'mock',ESF_ENV:'off',ESF_ALLOW_LIVE_SEND:'0',AI_MANAGER_URL:'',WHATSAPP_SELLER_URL:'',WHATSAPP_SELLER_SECRET:'',
 OPENAI_API_KEY:'',ANYMODEL_API_KEY:'',VAPID_PUBLIC_KEY:'',VAPID_PRIVATE_KEY:'',CRM_INLINE_AUTOMATION:'0',
 ALLOWED_ORIGINS:'http://127.0.0.1:4497',APP_BASE_URL:'http://127.0.0.1:4497',API_BASE_URL:'http://127.0.0.1:4498',
 LEGACY_APP_ORIGIN:'',LEGACY_REDIRECT_MODE:'off',SMTP_HOST:'',RESEND_API_KEY:'',TELEGRAM_BOT_TOKEN:''
});
globalThis.fetch = async () => { throw new Error('External network disabled in screenshot fixture'); };
const {createPrismaClient}=await import('../../packages/db/src/index.ts');
const {seedDatabase}=await import('../../packages/db/src/seed.ts');
const p=await createPrismaClient();
await seedDatabase();
const tenant=await p.tenant.findUniqueOrThrow({where:{slug:'demo-agency'}});
const tenantId=tenant.id;
await p.tenant.update({where:{id:tenantId},data:{name:'Aspan Studio · Демо',settingsJson:{onboarding:{status:'completed'}}}});
const user=await p.user.update({where:{email:'owner@demo-agency.example'},data:{name:'Алия Омарова',theme:'light'}});
const owner=await p.membership.findFirstOrThrow({where:{tenantId,userId:user.id}});
const legal={legalName:'ТОО «Aspan Studio» (демо)',shortName:'Aspan Studio',bin:'000000000000',legalAddress:'г. Алматы, проспект Демо, 10',email:'hello@aspan.example',iban:'KZ000000000000000000',bik:'DEMOXXXX',bankName:'Демонстрационный банк',directorName:'Алия Омарова',vatPayer:false,documentsEnabled:true};
await p.tenantLegalProfile.upsert({where:{tenantId},update:legal,create:{tenantId,...legal}});
const stages=await p.dealStage.findMany({where:{tenantId},orderBy:{sortOrder:'asc'}});
await p.inquiry.deleteMany({where:{tenantId}});
const clients=[
 ['Айдана Бекетова','Alma Interiors','Сайт для студии интерьера',480000,'whatsapp'],
 ['Данияр Аскаров','Orda Coffee','Сайт для сети кофеен',650000,'form'],
 ['Мария Соколова','Arman Development','Корпоративный сайт',1200000,'whatsapp'],
 ['Тимур Исаев','Nomad Travel','Рекламная кампания',350000,'whatsapp'],
 ['Аружан Сейтова','Dala Flowers','Интернет-магазин',780000,'form'],
 ['Руслан Ким','Qala Design','Дизайн презентации',240000,'instagram'],
 ['София Ахметова','Sulu Beauty','Контент для соцсетей',290000,'form'],
 ['Марат Сериков','Aq Jol Logistics','Обновление сайта',540000,'whatsapp'],
 ['Елена Пак','Terra Market','Каталог продукции',420000,'form'],
 ['Азамат Оспанов','Tau Hotels','Бронирование на сайте',960000,'whatsapp'],
 ['Диана Касымова','Ozen Events','Айдентика мероприятия',380000,'instagram'],
 ['Арсен Белов','Bala Education','Лендинг курса',320000,'form'],
] as const;
const ids:any={tenantId};
for(let i=0;i<clients.length;i++){
 const [name,companyName,title,amount,source]=clients[i];
 const company=await p.company.create({data:{tenantId,name:companyName,legalName:`ТОО «${companyName}» (демо)`,city:'Алматы',country:'KZ',legalAddress:'г. Алматы, улица Демо, 25',bin:`0000000000${String(i+1).padStart(2,'0')}`,assigneeMembershipId:owner.id,description:'Вымышленная компания для демонстрации Basqar.'}});
 const phone=`77000000${String(101+i).padStart(3,'0')}`;
 const contact=await p.contact.create({data:{tenantId,name,firstName:name.split(' ')[0],lastName:name.split(' ')[1],companyName,city:'Алматы',language:'ru',lifecycleStatus:'in_progress',leadTemperature:i%3===0?'hot':'warm',ownerMembershipId:owner.id,summary:`${title}. Бюджет согласован. Следующий шаг — подготовить предложение.`,methods:{create:[{type:'phone',rawValue:'+'+phone,normalizedValue:phone,source:'demo',primary:true},{type:'email',rawValue:`client${i+1}@example.com`,normalizedValue:`client${i+1}@example.com`,source:'demo'}]}}});
 await p.companyContact.create({data:{tenantId,companyId:company.id,contactId:contact.id,isPrimary:true,isDecisionMaker:true}});
 const inquiry=await p.inquiry.create({data:{tenantId,contactId:contact.id,companyId:company.id,companyName,city:'Алматы',desiredDeadline:'Ноябрь 2026',serviceCategory:'Digital',serviceSubcategory:title,source,sourceType:source,sourceChannel:source==='form'?'website':source,phoneRaw:'+'+phone,phoneNormalized:phone,phoneSource:'demo',subject:title,description:`${companyName}: ${title.toLowerCase()}. Нужны предложение, сроки и этапы работ.`,service:title,budgetMin:amount,budgetMax:amount+100000,status:i<3?'new':'accepted',needsReply:i<3,assigneeMembershipId:owner.id,nextStep:'Подготовить коммерческое предложение',receivedAt:new Date(Date.now()-i*45*60000)}});
 const stage=stages[Math.min(i%7,stages.length-1)];
 const deal=await p.deal.create({data:{tenantId,contactId:contact.id,companyId:company.id,stageId:stage.id,title,description:`Проект для ${companyName}. Демонстрационные данные.`,offerAmountMinor:amount,currency:'KZT',probability:stage.defaultProbability,assigneeMembershipId:owner.id,nextAction:'Согласовать предложение с клиентом',nextActionAt:new Date(Date.now()+86400000),expectedCloseAt:new Date(Date.now()+7*86400000),createdAt:new Date(Date.now()-i*86400000)}});
 await p.inquiry.update({where:{id:inquiry.id},data:{dealId:deal.id}});
 await p.dealItem.create({data:{tenantId,dealId:deal.id,name:title,quantity:1,unit:'услуга',unitPrice:amount,amountWithoutVat:amount,vatRate:0,vatAmount:0,totalAmount:amount}});
 await p.task.create({data:{tenantId,type:i%2?'call':'proposal',title:['Подготовить расчёт сайта для Айданы','Подготовить КП для Orda Coffee','Уточнить структуру сайта','Обсудить запуск рекламы','Согласовать каталог товаров','Отправить презентацию на проверку'][i%6].replace('Alina','Alma Interiors'),description:'Проверить детали проекта и согласовать следующий шаг с клиентом.',targetType:'client',contactId:contact.id,inquiryId:inquiry.id,dealId:deal.id,companyId:company.id,ownerMembershipId:owner.id,dueAt:new Date(Date.now()+((i%5)-1)*86400000),priority:i<2?'high':'normal',status:'open',source:'manual'}});
 if(i<6){const conv=await p.conversation.create({data:{tenantId,contactId:contact.id,mode:'human',status:'open',assigneeMembershipId:owner.id,contextSummary:`${title}. Бюджет ${amount.toLocaleString('ru-RU')} ₸. Клиент ожидает предложение.`}});
  const texts=[['client','inbound',`Здравствуйте! Нам нужен ${title.toLowerCase()}. Можете помочь?`],['staff','outbound',`Здравствуйте, ${name.split(' ')[0]}! Да, подскажите, какие сроки вы рассматриваете?`],['client','inbound','Хотим запустить проект в следующем месяце. Материалы уже подготовлены.'],['staff','outbound',`Отлично. Подготовлю предложение с этапами работ. Предварительный бюджет — ${amount.toLocaleString('ru-RU')} ₸.`],['client','inbound','Спасибо! Пришлите, пожалуйста, предложение и счёт.'],['staff','outbound','Хорошо, соберу документы и согласую с вами следующий шаг.']];
  for(let j=0;j<texts.length;j++){const [senderKind,direction,text]=texts[j];await p.message.create({data:{tenantId,conversationId:conv.id,senderKind,direction,text,receiptState:'read',createdAt:new Date(Date.now()-(20-j*2+i*30)*60000)}});}
  await p.dealConversation.create({data:{tenantId,dealId:deal.id,conversationId:conv.id}});
  await p.inquiry.update({where:{id:inquiry.id},data:{conversationId:conv.id}});
  if(i===0)ids.conversationId=conv.id;
 }
 if(i<6){const inv=await p.invoice.create({data:{tenantId,dealId:deal.id,companyId:company.id,number:`2026-${String(i+1).padStart(3,'0')}`,withoutContract:true,amountWithoutVat:amount,vatAmount:0,totalAmount:amount,status:'DRAFT',dueDate:new Date(Date.now()+7*86400000),items:{create:{name:title,quantity:1,unit:'услуга',unitPrice:amount,amountWithoutVat:amount,vatRate:0,vatAmount:0,totalAmount:amount}}}});if(i===0)ids.invoiceId=inv.id;}
 if(i<3)await p.contract.create({data:{tenantId,dealId:deal.id,companyId:company.id,number:'Д-2026-00'+(i+1),subject:title,amountWithoutVat:amount,vatAmount:0,totalAmount:amount,status:'DRAFT',paymentTerms:'100% предоплата',completionTerms:'30 календарных дней'}});
 await p.activity.create({data:{tenantId,contactId:contact.id,dealId:deal.id,inquiryId:inquiry.id,type:'inquiry.created',title:'Получена заявка',description:`${title} · ${companyName}`,actorType:'system'}});
 if(i===0)Object.assign(ids,{contactId:contact.id,dealId:deal.id,inquiryId:inquiry.id});
}

const {authForUserInTenant}=await import('../../apps/api/src/services/authService.ts');
const auth=await authForUserInTenant(p,user.id,tenantId,'screenshot-demo');
const {updateControlCompany,upsertControlAccess}=await import('../../apps/api/src/services/aiControlService.ts');
await updateControlCompany(p,auth,{enabled:true});
await upsertControlAccess(p,auth,user.id,{enabled:true,allowedSources:['CRM_CHAT'],canCreateTasks:true,canReadFinancialData:true,canReadTeamData:true});
const {sendControlWebMessage}=await import('../../apps/api/src/services/controlWebService.ts');
const {randomUUID}=await import('node:crypto');
await sendControlWebMessage(p,auth,{text:'Какие есть задачи на сегодня',requestId:randomUUID()});
const {emptyAiManagerDraft}=await import('@creolab/contracts');
const {getAiManagerSetup,saveAiManagerSetupDraft}=await import('../../apps/api/src/services/aiManagerSetupService.ts');
const initial=await getAiManagerSetup(p,auth);
const draft=emptyAiManagerDraft('Aspan Studio');
draft.primaryRole='sales'; draft.additionalRoles=['consultation','qualification'];
draft.company={name:'Aspan Studio',description:'Демонстрационная студия: разработка сайтов и дизайн для малого бизнеса.',audience:'Владельцы бизнеса, которым нужен сайт или обновление бренда.',geography:'Казахстан, работа онлайн',contacts:'hello@aspan.example',hours:'Понедельник–пятница, 09:00–18:00, Алматы'};
draft.offerings=[{id:'website',name:'Сайт для бизнеса',description:'Разработка сайта с каталогом услуг и формой заявки.',price:'Индивидуальный расчёт после согласования объёма.',includes:'Структура, дизайн, адаптивная вёрстка, форма заявки.',timing:'Срок согласовывает менеджер после брифа.',restrictions:'Стоимость, дату запуска и нестандартные интеграции подтверждает сотрудник.'},{id:'branding',name:'Фирменный стиль',description:'Разработка визуального оформления бренда.',price:'Индивидуальный расчёт.',includes:'Логотип, цвета, шрифты и руководство по использованию.',timing:'По согласованному плану.',restrictions:'Не обещать бесплатные доработки вне договора.'}];
draft.conversation={goalPreset:'quote_request',goal:'Собрать запрос на разработку сайта и передать сотруднику для расчёта.',questions:'Для какого бизнеса нужен сайт? Что на нём должно быть? Есть ли материалы и желаемая дата запуска?',completion:'Сверить задачу, материалы и сроки. С согласия клиента передать расчёт Алии.',successCriteria:'Понятны задача, объём и желаемые сроки. Клиент согласовал подготовку предложения.',style:'business',assistantName:'Ассистент Aspan',greeting:'Здравствуйте! Помогу разобраться с услугами Aspan Studio. Что вы хотите сделать?',benefits:'Согласуем структуру и этапы до начала работ. Сайт адаптируем под телефон.',objections:'Если бюджет неизвестен, сначала уточнить объём. Не обещать скидку и точную стоимость без расчёта.'};
draft.handoff={when:'Индивидуальная цена, договор, нестандартная интеграция, просьба о сотруднике.',contact:'Алия, менеджер проекта. Передать в текущем диалоге.'};
draft.faq=[{id:'faq-mobile',question:'Будет ли сайт работать на телефоне?',answer:'Да, адаптивная версия входит в разработку сайта.'},{id:'faq-time',question:'Когда можно запустить сайт?',answer:'Срок зависит от объёма и готовности материалов. Менеджер согласует дату после брифа.'}];
draft.terms.payment='Условия и этапы оплаты фиксируем в предложении и договоре.';
draft.knowledge=[{id:'knowledge-services',title:'Как проходит разработка сайта',content:'Сначала собираем задачу и материалы. Менеджер готовит расчёт. После согласования предложения и договора команда разрабатывает структуру, дизайн и сайт. Стоимость и сроки подтверждает менеджер.'}];
await saveAiManagerSetupDraft(p,auth,{revision:initial.revision,draft});

writeFileSync(path.join(base,'ids.json'),JSON.stringify(ids,null,2));
const {createApp}=await import('../../apps/api/src/app.ts');
const app=createApp(p);const server=app.listen(4498,'127.0.0.1');
const {createServer}=await import('vite');
const web=await createServer({root:path.resolve('apps/web'),configFile:path.resolve('apps/web/vite.config.ts'),server:{host:'127.0.0.1',port:4497,strictPort:true,proxy:{'/api':'http://127.0.0.1:4498','/public':'http://127.0.0.1:4498'}}});
await web.listen();console.log('DEMO_READY http://127.0.0.1:4497');
process.on('SIGTERM',async()=>{await web.close();server.close();await p.$disconnect();process.exit(0)});
