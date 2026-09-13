import assert from "node:assert/strict";
import { it } from "node:test";
import { documentErrorFields, documentFieldLabel } from "../../web/src/lib/documentErrors.ts";
import { NCALayerSigningClient } from "../../web/src/lib/signing/ncalayerClient.ts";

it("keeps distinct line errors and AUTH errors visible with useful labels", () => {
  const fields = documentErrorFields({body:{field_errors:{items:"old"},field_issues:[
    {path:"editor.items.0.name",message:"Заполните название"},
    {path:"editor.items.1.quantity",message:"Укажите количество"},
    {path:"signedAuthTicket",message:"Ожидается подписанный XML"},
  ]}});
  assert.deepEqual(Object.keys(fields),["items.0.name","items.1.quantity","signedAuthTicket"]);
  assert.equal(documentFieldLabel("items.1.quantity"),"Позиция 2: Количество");
  assert.equal(documentFieldLabel("signedAuthTicket"),"Ответ NCALayer для авторизации ИС ЭСФ");
  assert.deepEqual(documentErrorFields({body:{field_errors:{bin:["Неверный БИН","12 цифр"]}}},true),{"customer.bin":"Неверный БИН; 12 цифр"});
  assert.deepEqual(documentErrorFields({body:{details:{missingFields:["organization.bin"],missingFieldLabels:{"organization.bin":"Заполните БИН"}}}}),{"organization.bin":"Заполните БИН"});
});

it("NCALayer passes exactly one XML or CMS signature, rejects malformed/multiple results", async () => {
  const previousWindow=Object.getOwnPropertyDescriptor(globalThis,"window");
  const previousSocket=Object.getOwnPropertyDescriptor(globalThis,"WebSocket");
  let result:unknown;
  class Socket {
    static OPEN=1;readyState=1;onmessage:any;
    constructor(){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({result:{version:"test"}})}));}
    send(){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({status:true,body:{result}})}));}
    close(){this.readyState=3;}
  }
  Object.defineProperty(globalThis,"window",{value:{setTimeout,clearTimeout},configurable:true});
  Object.defineProperty(globalThis,"WebSocket",{value:Socket,configurable:true});
  try {
    for(const value of ["<signed/>",["<signed/>"]]){
      result=value;const client=new NCALayerSigningClient();
      assert.equal(await client.signXml("<ticket/>"),"<signed/>");client.disconnect();
    }
    result=["cms-signature"];const cms=new NCALayerSigningClient();
    assert.equal(await cms.signData("dGVzdA=="),"cms-signature");cms.disconnect();
    for(const value of [{xml:"no"},["first","second"],12,[null]]){
      result=value;const client=new NCALayerSigningClient();
      await assert.rejects(client.signXml("<ticket/>"),(error:any)=>error.code==="SIGNATURE_FAILED"||error.code==="USER_CANCELLED");client.disconnect();
    }
    result=[];const client=new NCALayerSigningClient();
    await assert.rejects(client.signXml("<ticket/>"),(error:any)=>error.code==="USER_CANCELLED");client.disconnect();
  } finally {
    if(previousWindow)Object.defineProperty(globalThis,"window",previousWindow);else Reflect.deleteProperty(globalThis,"window");
    if(previousSocket)Object.defineProperty(globalThis,"WebSocket",previousSocket);else Reflect.deleteProperty(globalThis,"WebSocket");
  }
});
