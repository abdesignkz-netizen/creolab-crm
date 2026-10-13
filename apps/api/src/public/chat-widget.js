/* BasQar website chat. No CRM cookies or model credentials are used by this client. */
(() => {
  const script = document.currentScript;
  if (!script || !script.dataset.basqar || document.querySelector('[data-basqar-chat-host]')) return;
  const key = script.dataset.basqar;
  if (!/^[a-f0-9-]{36}$/i.test(key)) return;
  const api = new URL(`/public/chat/${key}`, script.src).href;
  const storeKey = `basqar-chat:${key}`;
  let token = '', opened = false, busy = false, ready = false, lastVersion = '', pending = null;
  try { token = localStorage.getItem(storeKey) || ''; } catch {}
  if (!/^[a-f0-9]{64}$/.test(token)) token = '';
  async function request(path, body, auth = true) {
    const response = await fetch(api + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok) { const error = new Error(response.status === 401 ? 'Сессия истекла. Начните новый диалог.' : data.error?.message || data.message || 'Не удалось связаться. Попробуйте ещё раз.'); error.status = response.status; throw error; }
    return data;
  }
  request('/config', undefined, false).then(start).catch(() => {});
  function start(config) {
    const host = document.createElement('div'); host.dataset.basqarChatHost = ''; document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial;font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#1d2939;line-height:1.5}
      *{box-sizing:border-box}button,textarea{font:inherit}button{cursor:pointer}button:focus-visible,textarea:focus-visible{outline:3px solid #6ebaff;outline-offset:3px}button:disabled{opacity:.55;cursor:wait}
      .launcher{position:fixed;right:22px;bottom:max(22px,env(safe-area-inset-bottom));z-index:2147483000;border:0;border-radius:30px;background:var(--brand);color:var(--on-brand);box-shadow:0 6px 24px #172b4d33;padding:14px 20px;display:flex;gap:10px;align-items:center;font-weight:600}
      svg{width:24px;height:24px;flex:none}.chat{position:fixed;right:22px;bottom:max(90px,calc(env(safe-area-inset-bottom) + 80px));width:360px;height:520px;max-height:calc(100dvh - 120px);z-index:2147483001;border-radius:20px;border:1px solid #dde5ee;background:white;box-shadow:0 12px 50px #172b4d33;display:flex;flex-direction:column;overflow:hidden}.chat[hidden]{display:none}
      header{padding:16px 18px;background:var(--brand);color:var(--on-brand);display:flex;gap:10px;align-items:center}header div{flex:1;min-width:0}h2{font-size:17px;margin:0;overflow-wrap:anywhere}small{font-size:12px}.icon{border:0;background:transparent;color:inherit;padding:5px;font-size:24px;line-height:1}
      .history{flex:1;min-height:0;overflow-y:auto;padding:16px;background:#f5f7fa}.bubble{width:fit-content;max-width:92%;padding:10px 13px;margin:0 0 10px;background:white;border:1px solid #e4e9f0;border-radius:14px 14px 14px 3px;white-space:pre-wrap;overflow-wrap:anywhere}.mine{margin-left:auto;background:#e9f2ff;border-color:#d9e8fe;border-radius:14px 14px 3px 14px}time{display:block;font-size:10px;color:#667085;text-align:right;margin-top:4px}.greeting{color:#475467}.error{color:#a12424;background:#fff2f2;margin:0;padding:8px 14px;font-size:12px}.error:empty{display:none}form{display:flex;align-items:flex-end;gap:8px;padding:12px}textarea{resize:none;flex:1;min-width:0;border:1px solid #cbd5e1;border-radius:12px;padding:10px;color:#1d2939;background:white;height:65px}.send{border:0;border-radius:12px;padding:12px;background:var(--brand);color:var(--on-brand)}footer{display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:0 14px 10px;color:#667085}footer a{color:inherit}.new{border:0;background:none;color:#475467;font-size:11px;text-decoration:underline;padding:4px}
      @media(max-width:480px){.chat{right:10px;left:10px;width:auto;bottom:max(84px,calc(env(safe-area-inset-bottom) + 76px));height:65dvh;max-height:calc(100dvh - 104px)}.launcher{right:14px;bottom:max(14px,env(safe-area-inset-bottom));padding:12px 16px}}
    </style><button class="launcher" aria-expanded="false" aria-controls="basqar-panel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/><path d="M7 10h10M7 14h6"/></svg>Напишите нам</button>
    <section class="chat" id="basqar-panel" role="region" aria-label="Чат с компанией" hidden><header><div><h2></h2><small class="status">Чат с компанией</small></div><button class="icon close" aria-label="Закрыть чат">×</button></header><div class="history" role="log" aria-live="polite" aria-relevant="additions"></div><p class="error" role="alert"></p><form><textarea aria-label="Ваше сообщение" placeholder="Напишите сообщение…" maxlength="4000" required></textarea><button class="send" aria-label="Отправить сообщение"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m3 3 18 9-18 9 4-9-4-9Zm4 9h14"/></svg></button></form><footer><a href="https://bsqr.kz" target="_blank" rel="noopener noreferrer">Чат BasQar</a><button class="new" type="button">Новый диалог</button></footer></section>`;
    const $ = selector => root.querySelector(selector);
    const color = /^#[a-f0-9]{6}$/i.test(config.color) ? config.color : '#0065ca';
    const rgb = color.slice(1).match(/../g).map(v => parseInt(v, 16));
    host.style.setProperty('--brand', color); host.style.setProperty('--on-brand', rgb[0]*.299+rgb[1]*.587+rgb[2]*.114 > 160 ? '#172b4d' : '#fff');
    $('h2').textContent = config.title;
    function welcome() { $('.history').replaceChildren(); const greeting = document.createElement('p'); greeting.className = 'bubble greeting'; greeting.textContent = config.greeting; $('.history').append(greeting); }
    welcome();
    function showError(error) { $('.error').textContent = error.message || 'Связь прервалась. Повторите попытку.'; }
    function render(data) {
      $('.status').textContent = data.status === 'closed' ? 'Диалог завершён' : data.status === 'ai' ? 'Отвечает ИИ-помощник' : 'Сообщения переданы сотруднику';
      const version = JSON.stringify(data.items);
      if (version === lastVersion) return;
      const history = $('.history'), nearBottom = history.scrollHeight-history.scrollTop-history.clientHeight < 100;
      const previousIds = new Set([...history.querySelectorAll('[data-message]')].map(el => el.dataset.message));
      for (const message of data.items) {
        if (previousIds.has(message.id)) continue;
        const bubble = document.createElement('div'); bubble.dataset.message = message.id; bubble.className = 'bubble' + (message.direction === 'inbound' ? ' mine' : ''); bubble.textContent = message.text || '';
        const time = document.createElement('time'); time.dateTime = message.createdAt; time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); bubble.append(time); history.append(bubble);
      }
      lastVersion = version; if (nearBottom || busy) history.scrollTop = history.scrollHeight;
    }
    async function poll() {
      if (!opened || !token || busy || document.hidden) return;
      const current = token;
      try { const data = await request('/messages'); if(current !== token) return; render(data); $('.error').textContent = ''; }
      catch(error) { if(current === token) showError(error); }
    }
    function toggle(value) { opened = value; $('.chat').hidden = !value; $('.launcher').setAttribute('aria-expanded', String(value)); if(value){void poll();$('textarea').focus();}else $('.launcher').focus(); }
    $('.launcher').onclick = () => toggle(!opened); $('.close').onclick = () => toggle(false);
    root.addEventListener('keydown', event => { if(event.key === 'Escape') toggle(false); });
    $('.new').onclick = () => {
      if (busy) return;
      if (token && !window.confirm('Начать новый диалог? Предыдущая переписка останется у компании.')) return;
      token = ''; ready = false; pending = null; lastVersion = ''; try { localStorage.removeItem(storeKey); } catch {} welcome(); $('.error').textContent=''; $('.status').textContent='Чат с компанией'; $('textarea').focus();
    };
    $('form').onsubmit = async event => {
      event.preventDefault(); const text = $('textarea').value.trim(); if(busy || !text) return;
      busy = true; $('.send').disabled = true; $('.new').disabled = true; $('.error').textContent = '';
      // Keep the same request key after an ambiguous network failure.
      if (!pending || pending.text !== text) pending = { text, idempotencyKey: crypto.randomUUID() };
      try {
        if (!token) { token = [...crypto.getRandomValues(new Uint8Array(32))].map(v=>v.toString(16).padStart(2,'0')).join(''); try { localStorage.setItem(storeKey,token); } catch {} }
        if (!ready) { await request('/session', {}); ready = true; }
        render(await request('/messages', pending)); $('textarea').value = ''; pending = null;
      } catch(error) { showError(error); }
      finally { busy = false; $('.send').disabled = false; $('.new').disabled = false; $('textarea').focus(); }
    };
    $('textarea').addEventListener('keydown', event => { if(event.key === 'Enter' && !event.shiftKey && !event.isComposing){event.preventDefault();$('form').requestSubmit();} });
    setInterval(() => { if(host.isConnected) void poll(); }, 5000);
  }
})();
