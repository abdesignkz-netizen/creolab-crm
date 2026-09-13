import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {EsfIntegrationPage} from './src/pages/EsfIntegrationPage';
import {api} from './src/lib/api';
let active=false;
let calls=0;
let needed=false;
const state=()=>({connection:{status:active?'CONNECTED':needed?'REAUTH_REQUIRED':'NOT_CONNECTED',sessionActive:active,signerIin:'222222222220'},organization:{legalName:'Тестовая организация',bin:'123456789013'},system:{provider:'live',esfEnv:'test',liveSendAllowed:true},wsseRequired:needed,avrPoc:{ready:false,reasons:[]}});
api.esfConnection=async()=>state();
api.esfAuthTicket=async()=>({authTicketXml:'<synthetic/>'});
api.esfConnect=async(data:any)=>{
 calls++;
 if(calls===1){needed=true;throw Object.assign(new Error('Портал запросил пароль кабинета ИС ЭСФ'),{body:{...state(),wsseRequired:true,code:'esf_wsse_required'}});}
 if(data.cabinetPassword!=='synthetic-password'||data.cabinetUsername!=='222222222220'||data.signedAuthTicket!=='<signed/>')throw new Error('Тест: данные авторизации потеряны');
 active=true;needed=false;return state();
};
window.fetch=async()=>{throw new Error('В тесте внешние запросы запрещены');};
class TestSocket{static OPEN=1;readyState=1;onmessage:any;constructor(){setTimeout(()=>this.onmessage?.({data:JSON.stringify({result:{version:'test'}})}),0);}send(){setTimeout(()=>this.onmessage?.({data:JSON.stringify({status:true,body:{result:['<signed/>']}})}),0);}close(){this.readyState=3;}}
window.WebSocket=TestSocket as any;
createRoot(document.getElementById('root')!).render(<MemoryRouter><EsfIntegrationPage/></MemoryRouter>);
