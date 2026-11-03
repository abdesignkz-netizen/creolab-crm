import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

export default function AccountDeletionPage() {
  const [status, setStatus] = useState<'loading' | 'signed_in' | 'signed_out' | 'error'>('loading');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function load() {
    setStatus('loading');
    try { await api.request('/api/v1/me'); setStatus('signed_in'); }
    catch (err) { setStatus((err as { status?: number }).status === 401 ? 'signed_out' : 'error'); }
  }
  useEffect(() => { void load(); }, []);
  return <main className="login"><section className="panel stack" style={{ maxWidth: 640 }}>
    <h1>Удаление аккаунта BasQar</h1>
    <p>Здесь можно запросить удаление своего аккаунта и связанных персональных данных. Оператор проверит личность заявителя, права на данные компании и сообщит порядок и срок удаления через поддержку BasQar.</p>
    <p>Сам запрос ещё не удаляет аккаунт. Бухгалтерские документы и другие сведения, обязательные к хранению по закону, могут сохраняться в течение предусмотренного срока. Удаление личного аккаунта не означает удаление всей компании и данных других сотрудников.</p>
    <a href="/legal/privacy" target="_blank" rel="noreferrer">Политика конфиденциальности и контакты оператора</a>
    {status === 'loading' ? <p role="status">Проверяем вход…</p> : null}
    {status === 'signed_out' ? <Link className="btn" to="/login?next=account-deletion">Войти и отправить запрос</Link> : null}
    {status === 'error' ? <><p role="alert">Не удалось проверить вход. Повторите попытку.</p><button className="btn secondary" onClick={() => void load()}>Повторить</button></> : null}
    {status === 'signed_in' && !message ? <form className="stack" onSubmit={async event => {
      event.preventDefault(); if (!confirm || busy) return; setBusy(true); setError('');
      try { const result = await api.request<{ message: string }>('/api/v1/me/account-deletion-request', { method: 'POST', body: JSON.stringify({ confirm: true }) }); setMessage(result.message); }
      catch (err) { setError(err instanceof Error ? err.message : 'Не удалось отправить запрос.'); }
      finally { setBusy(false); }
    }}>
      <label><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} /> Хочу запросить удаление своего аккаунта и персональных данных</label>
      {error ? <p role="alert">{error}</p> : null}
      <button className="btn" disabled={!confirm || busy}>{busy ? 'Отправляем…' : 'Отправить запрос на удаление'}</button>
    </form> : null}
    {message ? <p role="status">{message}</p> : null}
    <Link to="/today">Вернуться в BasQar</Link>
  </section></main>;
}
