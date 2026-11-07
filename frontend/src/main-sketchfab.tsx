import { createRoot } from 'react-dom/client';
import SketchfabApp from './SketchfabApp';
import './style.css';
import { consumeAccountLink, watchAccountLinks } from './account-links';
consumeAccountLink();
watchAccountLinks();
createRoot(document.getElementById('root')!).render(<SketchfabApp />);
