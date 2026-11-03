// Presentation only. This flag never grants access or changes billing entitlements.
export function isNativeApp() {
  return typeof window !== 'undefined' && (/BasQarNative\/1(?:\s|$)/.test(window.navigator?.userAgent || '') ||
    (window as Window & { BasQarNative?: { version?: number } }).BasQarNative?.version === 1);
}

export const nativeAccountLabel = (locale: string) => locale === 'kk' ? 'Компанияның қолжетімділігі' : locale === 'en' ? 'Company access' : 'Доступ компании';

type NativeBridge = {
  version: number;
  download?: (blob: Blob, name: string) => Promise<void>;
  printPdf?: (html: string, name: string) => void;
};
function nativeBridge() {
  const bridge = typeof window !== 'undefined'
    ? (window as Window & { BasQarNative?: NativeBridge }).BasQarNative : undefined;
  return bridge?.version === 1 ? bridge : undefined;
}
export function downloadInNativeApp(blob: Blob, filename: string) {
  const bridge = nativeBridge();
  if (!bridge?.download) return false;
  // The bridge displays download failures through the native error handler.
  void bridge.download(blob, filename);
  return true;
}
export function printPdfInNativeApp(html: string, filename: string) {
  const bridge = nativeBridge();
  if (!bridge?.printPdf) return false;
  bridge.printPdf(html, filename);
  return true;
}
