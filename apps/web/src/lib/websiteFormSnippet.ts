/** The embedded form keeps its submission ID on retry; it changes only after editing or success. */
export function websiteFormSnippet(submitUrl: string, t: (message: string) => string = s => s) {
  const url = new URL(submitUrl);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid form URL");
  const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const literal = (s: string) => JSON.stringify(s).replaceAll("<", "\\u003c");
  return `<form method="POST" action="${escape(url.href)}" style="display:grid;gap:12px;max-width:480px">
  <label>${escape(t("Ваше имя"))}<input name="name" autocomplete="name" required maxlength="100" style="display:block;width:100%;box-sizing:border-box" /></label>
  <label>${escape(t("Телефон"))}<input name="phone" type="tel" autocomplete="tel" required style="display:block;width:100%;box-sizing:border-box" /></label>
  <label>${escape(t("Ваш вопрос"))}<textarea name="message" maxlength="4000" rows="3" style="display:block;width:100%;box-sizing:border-box"></textarea></label>
  <input name="website" type="text" tabindex="-1" autocomplete="off" hidden />
  <button type="submit">${escape(t("Отправить заявку"))}</button>
  <p role="status" aria-live="polite"></p>
</form>
<script>
(() => {
  const form = document.currentScript.previousElementSibling;
  const button = form.querySelector('button[type="submit"]');
  const notice = form.querySelector('[role="status"]');
  let submissionId = null;
  form.addEventListener('input', () => { submissionId = null; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    const body = Object.fromEntries(new FormData(form));
    body.pageUrl = location.href;
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      body[key] = new URLSearchParams(location.search).get(key) || '';
    }
    const controls = Array.from(form.querySelectorAll('input,textarea,button'));
    controls.forEach(control => { control.disabled = true; });
    notice.textContent = ${literal(t("Отправляем заявку…"))};
    try {
      submissionId ||= typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
      const response = await fetch(form.action, {
        method: 'POST', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', 'X-Submission-Id': submissionId },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000)
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error('submission_failed');
      form.reset(); submissionId = null;
      notice.textContent = ${literal(t("Заявка отправлена. Мы свяжемся с вами."))};
    } catch {
      notice.textContent = ${literal(t("Не удалось подтвердить отправку. Проверьте телефон и попробуйте ещё раз."))};
    } finally {
      controls.forEach(control => { control.disabled = false; });
    }
  });
})();
</script>`;
}
