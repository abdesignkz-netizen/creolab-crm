import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:4298';
const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@creolab.example',password:'ChangeMeLocal1!',client:'web'})});
assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
async function req(route:string,body?:unknown){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;}
const pdf=await readFile('/Users/ashat/Documents/CreoLab/Презентации новые 2026/Самиголла рыб завод/Договор.pdf');
const preview=await req('/api/v1/documents/import-pdf/preview',{kind:'CONTRACT',fileName:'Договор.pdf',fileBase64:pdf.toString('base64')});
assert.equal(preview.pageCount,6);assert.equal(preview.usedOcr,true);assert.equal(preview.draft.number,'12082026/01');assert.equal(preview.draft.date,'2026-08-12');assert.equal(preview.draft.buyer.bin,'140540016755');assert.equal(preview.draft.items.length,3);assert.equal(preview.draft.detectedTotal,400000);
const saved=await req('/api/v1/documents/import-pdf/confirm',{importId:preview.importId,draft:preview.draft});
const original=await fetch(base+`/api/v1/contracts/${saved.documentId}/pdf`,{headers:{cookie}});assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),pdf);
await writeFile('work/pdf-import/sample-flow-result.json',JSON.stringify({environment:'isolated temporary CRM',pageCount:6,usedOcr:true,number:preview.draft.number,date:preview.draft.date,itemCount:3,total:400000,dealId:saved.dealId,contractId:saved.documentId,pdfBytesPreserved:true,warnings:preview.warnings},null,2));
console.log('SAMPLE_FLOW_PASSED: six-page scan → preview → three positions / 400000 KZT → linked deal + contract → identical original PDF');
