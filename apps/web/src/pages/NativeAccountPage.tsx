import { useSession } from '../lib/session';
import { Link } from 'react-router-dom';

export default function NativeAccountPage() {
  const { me } = useSession();
  return <section className="panel stack">
    <h1>Доступ компании</h1>
    <p>{me?.activeTenant?.tenant?.name || 'BasQar'}</p>
    <p>В приложении доступны возможности, подключённые для вашей компании. Состав доступа и данные одинаковы с веб-кабинетом.</p>
    <p>Если нужная функция недоступна, уточните ваши права у владельца компании.</p>
    <Link className="btn secondary" to="/today">Вернуться к работе</Link>
    <Link to="/account-deletion">Удаление аккаунта и персональных данных</Link>
  </section>;
}
