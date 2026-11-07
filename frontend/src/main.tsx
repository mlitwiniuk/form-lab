import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
import { consumeAccountLink, watchAccountLinks } from './account-links';
consumeAccountLink();
watchAccountLinks();
createRoot(document.getElementById('root')!).render(<App />);
