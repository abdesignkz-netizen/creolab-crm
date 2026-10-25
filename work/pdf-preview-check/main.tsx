import React, { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PdfDocumentViewer } from '../../apps/web/src/components/PdfDocumentViewer';
import '../../apps/web/src/styles.css';

function App() {
  const [file, setFile] = useState<Blob | null>(null);
  async function open(bad = false) {
    const blob = bad ? new Blob(['broken PDF'], { type: 'application/pdf' }) : await (await fetch('./fixture.pdf')).blob();
    setFile(blob);
  }
  return <main style={{ padding: 16, maxWidth: 1100, margin: 'auto' }}>
    <h1>Просмотр PDF · проверка</h1><p>Тестовый документ, 2 страницы. Рабочие данные не используются.</p>
    <div className="actions"><button className="btn" onClick={() => void open()}>Открыть АВР</button><button className="btn secondary" onClick={() => void open(true)}>Повреждённый файл</button><button className="btn secondary" onClick={() => setFile(null)}>Закрыть просмотр</button></div>
    {file && <PdfDocumentViewer title="Тестовый АВР" file={file}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
