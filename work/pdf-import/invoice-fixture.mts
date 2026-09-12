import PDFDocument from 'pdfkit';
import {createWriteStream} from 'node:fs';
const pdf=new PDFDocument({size:'A4',margin:40});const out=createWriteStream('work/pdf-import/test-invoice.pdf');pdf.pipe(out);pdf.font('apps/api/assets/fonts/NotoSans-Regular.ttf').fontSize(14).text('Счёт на оплату № TEST-BILL-42 от 12.08.2026');
pdf.fontSize(10).text('Поставщик: ТОО «Creolab»\nБИН: 221140036408\nПокупатель: ТОО «Minerals Supply Services Atyrau»\nБИН: 140540016755\nОснование: Договор № 12082026/01\nБез НДС');
const x=[40,65,330,385,430,505];
for(const [i,row] of [['№','Наименование','Кол-во','Ед.','Цена','Сумма'],['1','Презентация','1','услуга','200000','200000'],['2','Логотип','1','услуга','100000','100000'],['3','Верстка','1','услуга','100000','100000']].entries())for(const [j,cell] of row.entries())pdf.text(cell,x[j],210+i*28,{width:j===1?245:65,lineBreak:false});
pdf.text('Итого: 400000',40,340);pdf.fontSize(9).text('ТЕСТОВЫЙ ФАЙЛ ДЛЯ ПРОВЕРКИ CRM',40,380);pdf.end();await new Promise<void>(r=>out.on('finish',r));
