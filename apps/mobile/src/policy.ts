export const FILE_LIMIT = 20 * 1024 * 1024;
export const CHUNK_SIZE = 64 * 1024;
export const PRINT_HTML_LIMIT = 512 * 1024;

// Android's share chooser can finish before the receiving app reads the file.
export function expiredExportFolder(name: string, now: number): boolean {
  const match = /^basqar-(?:pdf-)?(\d{13})$/.exec(name);
  return Boolean(match && now - Number(match[1]) >= 24 * 60 * 60 * 1000);
}

export function trustedUrl(value: string, origin: string): boolean {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}

export function fileLink(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:') return url.origin === origin;
    return trustedUrl(value, origin) && (url.pathname.startsWith('/api/') &&
      /\/(attachments\/[^/]+|download|pdf|excel|file|preview)(?:\/|$)/.test(url.pathname));
  } catch { return false; }
}

export function appLink(value: string, origin: string): string | null {
  try {
    const url = new URL(value);
    let route: string;
    if (url.protocol === 'basqar:' && url.hostname === 'app') route = `${url.pathname}${url.search}${url.hash}`;
    else if (trustedUrl(value, origin)) route = `${url.pathname}${url.search}${url.hash}`;
    else return null;
    if (/[%\\\u0000-\u0020]/.test(new URL(route, origin).pathname) || !route.startsWith('/') || route.startsWith('//')) return null;
    if (!/^\/(today|start|control|conversations|tasks|inquiries|requests|deals|contacts|clients|companies|documents|stats|settings|integrations|login|forgot-password|reset-password|sign|verify|legal|account-deletion)(\/|\?|#|$)/.test(route)) return null;
    return new URL(route, origin).href;
  } catch { return null; }
}

export function externalLink(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password &&
      (url.protocol === 'https:' || (/^(tel:|mailto:|sms:)$/.test(url.protocol) && !/[\r\n]/.test(decodeURIComponent(value))));
  } catch { return false; }
}

export function oauthRequest(value: string, origin: string): { provider: 'google' | 'instagram'; state: string } | null {
  try {
    const url = new URL(value);
    const provider = url.hostname === 'accounts.google.com' && url.pathname.startsWith('/o/oauth2/') ? 'google'
      : url.hostname === 'www.instagram.com' && url.pathname === '/oauth/authorize' ? 'instagram' : null;
    if (!provider || url.protocol !== 'https:' || url.username || url.password) return null;
    const state = url.searchParams.get('state') || '';
    if (!/^[a-f0-9]{64}$/.test(state) || url.searchParams.get('redirect_uri') !== `${origin}/api/v1/integrations/${provider}/callback`) return null;
    return { provider, state };
  } catch { return null; }
}

export function oauthCallback(value: string, origin: string, pending: { provider: string; state: string } | null): string | null {
  try {
    const url = new URL(value);
    if (!pending || url.protocol !== 'basqar:' || url.hostname !== 'oauth' || url.username || url.password || url.pathname) return null;
    if (url.searchParams.get('state') !== pending.state || url.searchParams.get('provider') !== pending.provider) return null;
    const result = new URL(`/api/v1/integrations/${pending.provider}/callback`, origin);
    for (const key of ['state', 'code', 'error']) {
      const values = url.searchParams.getAll(key);
      if (values.length > 1 || (values[0]?.length || 0) > 4096) return null;
      if (values[0]) result.searchParams.set(key, values[0]);
    }
    if (!result.searchParams.has('code') && !result.searchParams.has('error')) return null;
    return result.href;
  } catch { return null; }
}

export function safeFileName(value: unknown): string {
  const name = String(value || 'document').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').slice(0, 180);
  return name || 'document';
}

export function pdfRequest(message: Record<string, unknown>): { html: string; name: string } {
  if (typeof message.html !== 'string' || !/^<!doctype html>/i.test(message.html) || message.html.length > PRINT_HTML_LIMIT) {
    throw new Error('Не удалось подготовить PDF. Попробуйте выбрать меньший период отчёта.');
  }
  const name = safeFileName(message.name).replace(/\.pdf$/i, '').slice(0, 170);
  return { html: message.html, name: `${name}.pdf` };
}

export class FileTransfer {
  private file: { id: string; name: string; total: number; chunks: string[]; received: number } | null = null;
  get active() { return this.file !== null; }
  reset() { this.file = null; }
  accept(message: Record<string, unknown>): { name: string; base64: string } | null {
    if (message.type === 'file:start') {
      if (this.file) throw new Error('Дождитесь сохранения предыдущего файла.');
      if (typeof message.id !== 'string' || message.id.length > 80 || typeof message.size !== 'number' ||
          !Number.isInteger(message.size) || message.size < 0 || message.size > FILE_LIMIT) throw new Error('Файл слишком большой. Максимум — 20 МБ.');
      this.file = { id: message.id, name: safeFileName(message.name), total: 4 * Math.ceil(message.size / 3), chunks: [], received: 0 };
      return null;
    }
    const file = this.file;
    if (!file || file.id !== message.id) throw new Error('Загрузка файла прервана. Повторите скачивание.');
    if (message.type === 'file:chunk') {
      if (message.index !== file.chunks.length || typeof message.data !== 'string' || message.data.length > CHUNK_SIZE ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data) || file.received + message.data.length > file.total) {
        this.reset(); throw new Error('Не удалось проверить файл. Повторите скачивание.');
      }
      file.chunks.push(message.data); file.received += message.data.length;
      return null;
    }
    this.reset();
    if (message.type !== 'file:end' || file.received !== file.total) throw new Error('Файл загружен не полностью.');
    return { name: file.name, base64: file.chunks.join('') };
  }
}
