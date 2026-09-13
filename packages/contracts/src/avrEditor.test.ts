import assert from "node:assert/strict";
import { test } from "node:test";
import { avrEditorAmounts, avrEditorSchema } from "./avrEditor.ts";
const line={name:"Услуга",quantity:1,unit:"час",unitPrice:0.1,vatRate:12};
test("AVR money uses integer rounding per line, including fractional quantities",()=>{
  const a=avrEditorAmounts([{...line,quantity:1.125,unitPrice:100.1}]);
  assert.deepEqual(a.totals,{amountWithoutVat:112.61,vatAmount:13.51,totalAmount:126.12});
  assert.equal(avrEditorAmounts(Array.from({length:100},()=>line)).totals.totalAmount,11);
  assert.equal(avrEditorAmounts([{...line,quantity:0.5,unitPrice:0.01,vatRate:0}]).totals.totalAmount,0.01);
});
test("AVR dates, decimal precision and financial bounds are validated",()=>{
  const input={documentDate:"2026-09-13",items:[line]};
  assert.ok(avrEditorSchema.safeParse(input).success);
  assert.ok(avrEditorSchema.safeParse({...input,items:[]}).success);
  for(const patch of [{quantity:0},{quantity:1.0001},{unitPrice:0.001},{vatRate:101},{quantity:1e6,unitPrice:1e9}])assert.equal(avrEditorSchema.safeParse({...input,items:[{...line,...patch}]}).success,false);
  assert.equal(avrEditorSchema.safeParse({...input,documentDate:"2026-02-30"}).success,false);
});
