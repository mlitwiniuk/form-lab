import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Focus, Link, LockKeyhole, UnlockKeyhole } from 'lucide-react';
import { WorkspaceHeader } from './AccountWorkspace';
import { errorMessage } from './library';
import { DEFAULT_MODEL, SketchfabReference, modelId, parseSketchfabSettings, settingsFromSearch, settingsUrl, type ProjectionMode, type ViewerState } from './sketchfab-viewer';
export default function SketchfabApp() {
  const iframe = useRef<HTMLIFrameElement>(null), viewer = useRef<SketchfabReference | null>(null);
  const [state, setState] = useState<ViewerState>({ ready: false, busy: true, uid: '', projection: 'flat', step: 5, locked: false, message: 'Connecting to Sketchfab…' });
  const [input, setInput] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState(''), [manualLink, setManualLink] = useState('');
  useEffect(() => {
    let disposed = false, instance: SketchfabReference | null = null;
    const fail = () => { if (!disposed) setState(s => ({ ...s, busy: false, message: 'Sketchfab could not be reached. Check your connection and reload this page.' })); };
    const start = () => {
      if (disposed) return;
      if (!window.Sketchfab) { fail(); return; }
      try {
        instance = new SketchfabReference(new window.Sketchfab(iframe.current!), s => {
          if (disposed) return;
          setState(s); if (s.ready) { try { localStorage.setItem('sketch-reference-model', s.uid); } catch {} }
        });
        viewer.current = instance;
        const shared = settingsFromSearch(location.search); let initial = shared?.uid ?? DEFAULT_MODEL;
        try { if (!shared) initial = modelId(localStorage.getItem('sketch-reference-model') ?? '') ?? DEFAULT_MODEL; } catch {}
        setInput(initial); void instance.load(initial, shared ?? undefined).catch(e => { if (!disposed) setError(errorMessage(e)); });
      } catch { fail(); }
    };
    // Load the external renderer without blocking the header, account dialog or library.
    const script = document.createElement('script'); script.src = 'https://static.sketchfab.com/api/sketchfab-viewer-1.12.1.js'; script.async = true;
    const timer = setTimeout(fail, 20000);
    script.onload = () => { clearTimeout(timer); start(); }; script.onerror = () => { clearTimeout(timer); fail(); };
    if (window.Sketchfab) { clearTimeout(timer); start(); } else document.head.append(script);
    return () => { disposed = true; clearTimeout(timer); script.remove(); instance?.dispose(); viewer.current = null; };
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  async function action(task: () => Promise<unknown> | undefined) { setError(''); try { await task(); } catch (e) { setError(errorMessage(e)); } }
  const disabled = !state.ready || state.busy, editingDisabled = disabled || state.locked;
  return <div className="app sketchfab-app">
    <WorkspaceHeader kind="sketchfab" disabled={disabled} restoreReady={!!viewer.current} capture={async () => {
      if (!viewer.current) throw new Error('Load a model before saving.'); return viewer.current.capture();
    }} restore={async settings => { const view = parseSketchfabSettings(settings); if (!viewer.current) throw new Error('Sketchfab is unavailable. Check your connection and reload this page.'); setInput(view.uid); await viewer.current.load(view.uid, view); }}>
      <button className="secondary-button share-button" disabled={disabled} aria-label="Copy share link" onClick={() => void action(async () => { const url = settingsUrl(await viewer.current!.capture(), location.origin); try { await navigator.clipboard.writeText(url); setNotice('View link copied.'); } catch { setManualLink(url); } })}><Link size={17} /><span>Share link</span></button>
      <button className="secondary-button export-button" disabled={disabled} aria-label="Save image" onClick={() => void action(async () => { const image = await viewer.current!.image(); if (!image.startsWith('data:image/')) throw new Error('Sketchfab returned an invalid image.'); const a = document.createElement('a'); a.href = image; a.download = 'sketchfab-reference.png'; document.body.append(a); a.click(); a.remove(); setNotice('Image saved.'); })}><ArrowDownToLine size={17} /><span>Save image</span></button>
      <button className={`primary-button drawing-button ${state.locked ? 'locked' : ''}`} disabled={disabled} aria-pressed={state.locked} onClick={() => viewer.current?.lock()}>{state.locked ? <UnlockKeyhole size={16} /> : <LockKeyhole size={16} />}<span>{state.locked ? 'Edit view' : 'Start drawing'}</span></button>
    </WorkspaceHeader>
    <main className="workspace">
      <section className="studio" aria-label="Sketchfab reference workspace">
        <div className="studio-toolbar"><div className="view-label"><span className={`live-dot ${state.busy ? 'busy' : ''}`} />{state.locked ? 'REFERENCE LOCKED' : 'YOUR REFERENCE'}</div><span className="sketchfab-attribution">Powered by Sketchfab</span></div>
        <div className="camera-row"><span className="canvas-caption">{state.projection === 'flat' ? 'Near-orthographic' : state.projection === 'wide' ? 'Wide perspective' : 'Original perspective'}</span><div className="view-presets" aria-label="Camera views">{[['threequarter','3D'],['front','Front'],['left','Side'],['top','Top']].map(([key,label]) => <button key={key} disabled={editingDisabled} onClick={() => void action(() => viewer.current?.preset(key))}>{label}</button>)}<button disabled={editingDisabled} title="Reset zoom" aria-label="Reset zoom" onClick={() => void action(() => viewer.current?.zoom(1,true))}><Focus size={17} /></button></div></div>
        <iframe ref={iframe} className="sketchfab-frame" title="Sketchfab 3D model" allow="autoplay; fullscreen; xr-spatial-tracking" allowFullScreen />
        <div className="canvas-hint">{state.locked ? 'Reference locked for drawing.' : 'Drag to orbit · Scroll to zoom · Right-drag to pan'}</div>
        <div className="sketchfab-status" role="status">{error || notice || state.message}</div>
      </section>
      <aside className="inspector" aria-label="Model and camera controls"><div className="inspector-body">
        <div className="panel-heading"><span className="eyebrow">SKETCHFAB / REFERENCE</span><h1>Find your angle.</h1><p>Bring a model into your drawing practice. Frame it, turn it, and keep the view.</p></div>
        <form className="account-form model-load" onSubmit={e => { e.preventDefault(); void action(() => viewer.current?.load(input)); }}><label htmlFor="model">Model link or ID<input id="model" value={input} onChange={e => setInput(e.target.value)} required placeholder="Paste a Sketchfab link" /></label><button className="primary-button full-width" disabled={!viewer.current || state.busy}>Load model</button></form>
        <section className="sketchfab-controls"><div className="section-caption">PROJECTION</div><div className="select-wrap"><select aria-label="Projection" value={state.projection} disabled={editingDisabled} onChange={e => void action(() => viewer.current?.projection(e.target.value as ProjectionMode))}><option value="flat">Near-orthographic</option><option value="original">Original perspective</option><option value="wide">Wide perspective</option></select></div><p className="parameter-tip">Near-orthographic uses a narrow field of view. Slight perspective remains.</p></section>
        <section className="sketchfab-controls"><div className="section-caption">ROTATE ONE AXIS</div><div className="orbit-grid">{([{direction:'left',label:'Left',Icon:ArrowLeft},{direction:'right',label:'Right',Icon:ArrowRight},{direction:'up',label:'Up',Icon:ArrowUp},{direction:'down',label:'Down',Icon:ArrowDown}] as const).map(({direction,label,Icon}) => <button className="secondary-button" key={direction} disabled={editingDisabled} onClick={() => void action(() => viewer.current?.orbit(direction))}><Icon size={16} />{label}</button>)}</div><label className="rotation-step">Rotation step<select aria-label="Rotation step" value={state.step} disabled={editingDisabled} onChange={e => viewer.current?.step(Number(e.target.value))}>{[1,5,15,45].map(step => <option key={step} value={step}>{step}°</option>)}</select></label></section>
        <section className="sketchfab-controls"><div className="section-caption">FRAMING</div><div className="orbit-grid"><button className="secondary-button" disabled={editingDisabled} onClick={() => void action(() => viewer.current?.zoom(.8))}>Zoom in</button><button className="secondary-button" disabled={editingDisabled} onClick={() => void action(() => viewer.current?.zoom(1.25))}>Zoom out</button></div><button className="text-button" disabled={editingDisabled} onClick={() => void action(() => viewer.current?.zoom(1,true))}>Reset zoom</button></section>
        <p className="parameter-tip">Save keeps your model, camera, projection and drawing lock in your account. You can save several angles of the same model.</p><p className="parameter-tip">Models load from Sketchfab and must allow embedding. Saved references contain settings, not model files.</p>
      </div></aside>
    </main>
    {manualLink && <div className="manual-view-link"><label>Copy this view link<input readOnly value={manualLink} onFocus={e => e.target.select()} /></label><button className="secondary-button" onClick={() => setManualLink('')}>Done</button></div>}
  </div>;
}
