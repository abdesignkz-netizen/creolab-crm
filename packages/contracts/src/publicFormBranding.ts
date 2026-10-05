// A historical seeded form has a public URL used by existing websites.
// Present the BasQar alias, while accepting either spelling for the same form.
export const LEGACY_SITE_FORM_KEY = "frm_creolab_site_demo";
export const BASQAR_SITE_FORM_KEY = "frm_basqar_site_demo";
export function publicFormKey(key: string): string {
  return key === LEGACY_SITE_FORM_KEY ? BASQAR_SITE_FORM_KEY : key;
}
export function publicFormKeyAliases(key: string): string[] {
  return [LEGACY_SITE_FORM_KEY, BASQAR_SITE_FORM_KEY].includes(key)
    ? [LEGACY_SITE_FORM_KEY, BASQAR_SITE_FORM_KEY] : [key];
}
