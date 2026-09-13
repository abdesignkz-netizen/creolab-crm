import { api } from "../api";
import { createNcalayerClient, NcalayerError } from "./ncalayerClient";
/** Existing AUTH-ticket flow, shared by integration settings and the document card. */
export async function connectEsfAuthTicket(iin:string) {
  if(!/^\d{12}$/.test(iin.trim()))throw new Error("Укажите ИИН пользователя — 12 цифр");
  const client=createNcalayerClient();
  try {
    if(!await client.isAvailable())throw new NcalayerError("NCALAYER_NOT_RUNNING","Запустите NCALayer и повторите подключение");
    const ticket=await api.esfAuthTicket(iin.trim()) as {authTicketXml:string};
    const signedAuthTicket=await client.signXml(ticket.authTicketXml,{extKeyUsageOids:[]});
    return await api.esfConnect({signedAuthTicket});
  } finally {client.disconnect();}
}
