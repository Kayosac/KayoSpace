import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

// StrictMode не включаем: двойной запуск эффектов в разработке пересоздавал бы холст и соединение с хабом.
createRoot(document.getElementById('root')!).render(<App />);
