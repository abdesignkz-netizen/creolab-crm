/** Public sharing deliberately accepts only the document type, number and date. */
export const BASQAR_PAGE_TITLE = 'BasQar — Умный контур ведения бизнеса';
export const BASQAR_TAGLINE = 'Умный контур ведения бизнеса';
export const SIGN_PREVIEW_IMAGE = '/og/document-sign-v1.png';
export const DOCUMENT_SIGN_TYPES = {
  AVR: { name: 'Акт выполненных работ', shortName: 'АВР' },
  CONTRACT: { name: 'Договор', shortName: 'Договор' },
  INVOICE: { name: 'Счёт', shortName: 'Счёт' },
  ESF: { name: 'Электронный счёт-фактура', shortName: 'ЭСФ' },
  DOCUMENT: { name: 'Документ', shortName: 'Документ' },
} as const;
export type DocumentSignType = keyof typeof DOCUMENT_SIGN_TYPES;

export function publicDocumentText(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return /^(null|undefined|nan)$/i.test(text) ? '' : text.slice(0, 120);
}

export function getDocumentSignMeta(type: string, document?: { number?: unknown; date?: unknown } | null) {
  const key = type.toUpperCase();
  const documentType: DocumentSignType = Object.hasOwn(DOCUMENT_SIGN_TYPES, key) ? key as DocumentSignType : 'DOCUMENT';
  const { name, shortName } = DOCUMENT_SIGN_TYPES[documentType];
  const number = publicDocumentText(document?.number).replace(/^(?:№|No\.?)[\s]*/i, '');
  const rawDate = document?.date;
  const parsed = rawDate instanceof Date ? rawDate : typeof rawDate === 'string' && rawDate.trim() ? new Date(rawDate) : null;
  const date = parsed && Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' }).format(parsed) : '';
  const suffix = `${number ? ` №${number}` : ''}${date ? ` от ${date}` : ''}`;
  const description = document ? `Документ на подпись: ${shortName}${suffix}` : 'Документ на подпись в BasQar';
  return { documentType, name, number, date, heading: `${name}${suffix}`, pageTitle: BASQAR_PAGE_TITLE,
    description, preview: { title: BASQAR_PAGE_TITLE, description, image: SIGN_PREVIEW_IMAGE,
      imageAlt: 'BasQar — Умный контур ведения бизнеса. Документ на подпись', width: 1200, height: 630, type: 'website' } };
}
