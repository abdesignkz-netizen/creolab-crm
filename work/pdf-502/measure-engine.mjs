import { createRequire } from 'node:module';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const mib = bytes => Math.round(bytes / 1024 / 1024);
const baseline = process.memoryUsage().rss;
const { createWorker, PSM } = await import('tesseract.js');
const imported = process.memoryUsage().rss;
const languageDir = await mkdtemp(path.join(tmpdir(), 'crm-ocr-measure-'));
let worker;
let peak = imported;
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
try {
  await Promise.all(['rus', 'eng'].map(async code => {
    const { langPath } = require(`@tesseract.js-data/${code}`);
    await copyFile(path.join(langPath, `${code}.traineddata.gz`), path.join(languageDir, `${code}.traineddata.gz`));
  }));
  worker = await createWorker('rus+eng', 1, { langPath: languageDir, cacheMethod: 'none', errorHandler: () => undefined });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
  const ready = process.memoryUsage().rss;
  console.log(JSON.stringify({ baselineMiB: mib(baseline), libraryImportedMiB: mib(imported), readyProcessMiB: mib(ready), addedEngineMiB: mib(ready - baseline), initPeakProcessMiB: mib(Math.max(peak, ready)), maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
} finally {
  clearInterval(timer);
  await worker?.terminate();
  await rm(languageDir, { recursive: true, force: true });
}
