import { z } from "zod";
const decimal = (places: number, max: number) => z.coerce.number().finite().nonnegative().max(max).refine(n => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 0.00001, `Не более ${places} знаков после запятой`);
export const avrEditorSchema = z.object({
  number: z.string().trim().max(40, "Не более 40 символов").regex(/^[^\x00-\x1f\x7f]*$/, "Номер не должен содержать управляющие символы").optional(),
  documentDate: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(s=>!Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s,"Укажите дату"),
  items: z.array(z.object({name:z.string().trim().min(1).max(1000),quantity:decimal(3,1e6).refine(n=>n>0,"Укажите количество"),unit:z.string().trim().min(1).max(40),unitPrice:decimal(2,1e9),vatRate:decimal(2,100)})).max(100),
}).refine(d=>d.items.reduce((s,i)=>s+i.quantity*i.unitPrice*(1+i.vatRate/100),0)<=1e12,"Сумма документа превышает допустимый предел");
export type AvrEditorInput = z.infer<typeof avrEditorSchema>;
// Integer arithmetic: quantities in thousandths, prices in cents, tax in basis points.
export function avrEditorAmounts(items: AvrEditorInput["items"]) {
  const scaled=(n:number,p:number)=>BigInt(n.toFixed(p).replace(".",""));
  const rows=items.map(i=>{const base=(scaled(i.quantity,3)*scaled(i.unitPrice,2)+500n)/1000n;const vat=(base*scaled(i.vatRate,2)+5000n)/10000n;return {base,vat,total:base+vat};});
  const money=(n:bigint)=>Number(n)/100;
  return {rows:rows.map(r=>({amountWithoutVat:money(r.base),vatAmount:money(r.vat),totalAmount:money(r.total)})),totals:{amountWithoutVat:money(rows.reduce((s,r)=>s+r.base,0n)),vatAmount:money(rows.reduce((s,r)=>s+r.vat,0n)),totalAmount:money(rows.reduce((s,r)=>s+r.total,0n))}};
}
