import { getLegalBundle, legalReleaseIssues, legalProfile } from '../apps/api/src/services/legalDocuments.ts';
const issues = legalReleaseIssues(legalProfile);
if (issues.length) {
  console.error('Публикация правового пакета пока не готова:');
  for (const issue of issues) console.error(`- ${issue}`);
  console.error('Порядок проверки: docs/legal/README.md. Флаги не заменяют доказательства выполнения.');
  process.exitCode = 1;
} else {
  console.log(`Проверка заполнения пройдена. Редакция: ${getLegalBundle(legalProfile, false).revision}`);
  console.log('Это проверка конфигурации, а не юридическое заключение или аудит инфраструктуры.');
}
