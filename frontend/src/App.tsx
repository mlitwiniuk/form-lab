import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Box, Check, ChevronDown, ChevronUp, Focus, HelpCircle, Layers3, Plus, Trash2, Link, LockKeyhole, Maximize2, MousePointer2, Move3D, Redo2, Rotate3D, RotateCcw, Shuffle, Undo2, UnlockKeyhole, X } from 'lucide-react';
import { DEFAULT_SCENE, MAX_SHAPES, addShape, removeShape, shapeEntries, getShape, bendLimit, cloneScene, constrainBend, constrainCurvePoint, curveOffsetLimit, CURVE_GAP, generateRounded, makeShape, PRESETS, SHAPES, shapeName, type FormAppearance, type DisplayMode, type Deformation, type ShapeKind, type GeometryResult, type Operation, type Reveals, type SceneState, type ShapeId, type Tool, type Vec3 } from './scene';
import { formAppearance, referenceAppearance, setFormAppearance } from './appearance';
import { Viewport } from './viewport';
import { GeometryPipeline } from './geometry-pipeline';
import { curveFromShape, type GeometryQuality } from './forms';
import { decodeStudy, DEFAULT_CAMERA, encodeStudy, type SharedStudy } from './share-state';
import { ShareSync } from './share-sync';

const OPERATIONS: { id: Operation; label: string; symbol: string; description: string }[] = [
  { id: 'single', label: 'Single form', symbol: '○', description: 'Study and deform form A on its own' },
  { id: 'subtract', label: 'Cut', symbol: '−', description: 'Remove all other forms from form A' },
  { id: 'union', label: 'Join', symbol: '+', description: 'Join all forms into one solid' },
  { id: 'intersect', label: 'Shared', symbol: '∩', description: 'Keep only the volume shared by every form' },
  { id: 'reverse', label: 'Reverse cut', symbol: '↔', description: 'Join the other forms, then remove form A' },
  { id: 'exclude', label: 'Remove overlap', symbol: '⊖', description: 'Remove the overlap between A and the joined other forms' },
];
const PANELS = [{ id: 'study', label: 'Study' }, { id: 'shape', label: 'Shape' }, { id: 'deform', label: 'Deform' }, { id: 'draw', label: 'Draw' }] as const;
type Panel = typeof PANELS[number]['id'];

const INITIAL_REVEALS: Reveals = { cutter: true, construction: true, hidden: false, seam: true };
const freshStudy = (): SharedStudy => ({ version: 4, display: 'wireframe', scene: cloneScene(DEFAULT_SCENE),
  camera: structuredClone(DEFAULT_CAMERA), reveals: { ...INITIAL_REVEALS, construction: false, seam: false }, locked: false, focus: false });
const studySignature = (scene: SceneState) => JSON.stringify(scene, (key, value) => key === 'appearance' ? undefined : value);
const presetSignatures = PRESETS.map(p => studySignature(p.scene));
const matchingPreset = (scene: SceneState) => presetSignatures.indexOf(studySignature(scene));
function initialStudy() {
  try { return { study: decodeStudy(window.location.hash) ?? freshStudy(), error: '', fit: !window.location.hash }; }
  catch (error) { return { study: freshStudy(), fit: true, error: error instanceof Error ? error.message : 'This share link could not be opened.' }; }
}

function Slider({ label, value, min, max, step = .05, suffix = '', disabled, onChange, onCommit }: {
  label: string; value: number; min: number; max: number; step?: number; suffix?: string; disabled: boolean;
  onChange: (value: number) => void; onCommit: () => void;
}) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(2))));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(Number(value.toFixed(2)))); }, [value]);
  function finishNumber() {
    editing.current = false;
    const parsed = draft.trim() === '' ? value : Number(draft);
    const bounded = Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : value;
    const next = step === 1 ? Math.round(bounded) : bounded;
    onChange(next); setDraft(String(Number(next.toFixed(2)))); onCommit();
  }
  return <div className="slider-control"><span className="control-label">{label}<span className="number-wrap"><input
    aria-label={`${label} value`} type="number" min={min} max={max} step={step} value={draft} disabled={disabled}
    onFocus={() => { editing.current = true; }}
    onChange={e => { setDraft(e.target.value); const number = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(number) && number >= min && number <= max) onChange(number); }}
    onBlur={finishNumber} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />{suffix}</span></span>
    <input aria-label={label} type="range" min={min} max={max} step={step} value={value} disabled={disabled}
      style={{ '--range-progress': `${(value - min) / (max - min) * 100}%` } as React.CSSProperties}
      onChange={e => onChange(Number(e.target.value))} onPointerUp={onCommit} onPointerCancel={onCommit} onKeyUp={onCommit} onBlur={onCommit} />
  </div>;
}

export default function App() {
  const [initial] = useState(initialStudy);
  const fitPending = useRef(initial.fit);
  const [panel, setPanel] = useState<Panel>(initial.study.locked ? 'draw' : 'study');
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const panelBody = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState(initial.study.scene);
  const sceneRef = useRef(scene);
  const committed = useRef(cloneScene(scene));
  const generatedStudy = useRef(cloneScene(scene));
  const [past, setPast] = useState<SceneState[]>([]), [future, setFuture] = useState<SceneState[]>([]);
  const [selection, setSelected] = useState<ShapeId>('a');
  const forms = shapeEntries(scene);
  const selected = forms.some(([id]) => id === selection) ? selection : 'a';
  const [addKind, setAddKind] = useState<ShapeKind>('box');
  const [tool, setTool] = useState<Tool>('scale');
  const [locked, setLocked] = useState(initial.study.locked), [snap, setSnap] = useState(false);
  const [display, setDisplay] = useState<DisplayMode>(initial.study.display ?? 'solid');
  const appearance = referenceAppearance(scene, display);
  const wireframe = appearance.allWireframe;
  const [reveals, setReveals] = useState<Reveals>(initial.study.reveals);
  const [stage, setStage] = useState<number | null>(null);
  const [preset, setPreset] = useState(() => matchingPreset(scene));
  const [help, setHelp] = useState(false), [focus, setFocus] = useState(initial.study.focus);
  const [exported, setExported] = useState<string | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [metrics, setMetrics] = useState<Pick<GeometryResult, 'duration' | 'volume' | 'bodyVolume' | 'overlapVolume'> | null>(null);
  const [engineRestart, setEngineRestart] = useState(0);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null), viewport = useRef<Viewport | null>(null);
  const pipeline = useRef<GeometryPipeline | null>(null);
  const [displayQuality, setDisplayQuality] = useState<GeometryQuality | null>(null);
  const [curveEditing, setCurveEditing] = useState(false), [curvePoint, setCurvePoint] = useState(2);
  const [linkError, setLinkError] = useState(initial.error);
  const [shareStatus, setShareStatus] = useState('');
  const [manualLink, setManualLink] = useState<string | null>(null);
  const shareButton = useRef<HTMLButtonElement>(null);
  const sharing = useRef<ShareSync | null>(null), pauseSharing = useRef(!!initial.error);
  const readStudy = useRef<() => SharedStudy>(() => initial.study);
  readStudy.current = () => ({ version: 4, display, scene: sceneRef.current,
    camera: viewport.current?.getCameraState() ?? initial.study.camera, reveals, locked, focus });
  const syncUrl = useCallback((finished = false) => {
    if (pauseSharing.current) return;
    try { if (finished) sharing.current?.flush(); else sharing.current?.schedule(); }
    catch { setShareStatus('The address could not be updated. Use Copy share link to keep this study.'); }
  }, []);
  const callbacks = useRef({ edit: (_next: SceneState) => {}, commit: () => {}, select: (_id: ShapeId) => {}, drag: (_active: boolean) => {}, point: (_index: number) => {} });

  const edit = useCallback((next: SceneState) => { sceneRef.current = next; setScene(next); setPreset(matchingPreset(next)); syncUrl(); }, [syncUrl]);
  const checkpoint = useCallback(() => {
    syncUrl(true);
    if (JSON.stringify(committed.current) === JSON.stringify(sceneRef.current)) return;
    const previous = cloneScene(committed.current);
    setPast(history => [...history.slice(-49), previous]); setFuture([]);
    committed.current = cloneScene(sceneRef.current);
  }, [syncUrl]);
  callbacks.current = { edit, commit: checkpoint, select: setSelected, drag: setDragging, point: setCurvePoint };

  useEffect(() => {
    try {
      viewport.current = new Viewport(containerRef.current!, {
        edit: next => callbacks.current.edit(next), commit: () => callbacks.current.commit(),
        select: id => callbacks.current.select(id), drag: active => callbacks.current.drag(active),
        point: index => callbacks.current.point(index),
        view: finished => syncUrl(finished),
      });
      viewport.current.setScene(sceneRef.current);
      viewport.current.setCameraState(initial.study.camera);
    } catch { setError('The 3D view needs WebGL. Try a browser with hardware acceleration enabled.'); }
    return () => { viewport.current?.dispose(); viewport.current = null; };
  }, [initial, syncUrl]);

  useEffect(() => {
    const sync = new ShareSync(() => readStudy.current(), hash => {
      if (window.location.hash !== hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
    }, () => setShareStatus('The address could not be updated. Use Copy share link to keep this study.'));
    sharing.current = sync;
    const loadLink = () => {
      sync.cancel(); pauseSharing.current = true;
      try {
        const next = decodeStudy(window.location.hash) ?? freshStudy();
        fitPending.current = !window.location.hash;
        viewport.current?.cancelDrag();
        sceneRef.current = next.scene; setScene(next.scene);
        committed.current = cloneScene(next.scene); generatedStudy.current = cloneScene(next.scene);
        setPast([]); setFuture([]); setPreset(matchingPreset(next.scene));
        setDisplay(next.display ?? 'solid'); setReveals(next.reveals); setLocked(next.locked); setFocus(next.focus); setStage(null);
        setSelected('a'); setCurveEditing(false); setCurvePoint(2); setTool('scale'); setSnap(false);
        setPanel(next.locked ? 'draw' : 'study'); setControlsCollapsed(false);
        setExported(null); setHelp(false); setManualLink(null); setShareStatus('');
        viewport.current?.setCameraState(next.camera);
        setLinkError(''); pauseSharing.current = false;
      } catch (error) { setLinkError(error instanceof Error ? error.message : 'This share link could not be opened.'); }
    };
    const finish = () => syncUrl(true);
    window.addEventListener('hashchange', loadLink);
    window.addEventListener('pagehide', finish);
    window.addEventListener('beforeunload', finish);
    return () => {
      sync.cancel(); sharing.current = null;
      window.removeEventListener('hashchange', loadLink);
      window.removeEventListener('pagehide', finish);
      window.removeEventListener('beforeunload', finish);
    };
  }, [syncUrl]);

  useEffect(() => { syncUrl(); }, [scene, display, reveals, locked, focus, syncUrl]);
  useEffect(() => {
    if (!shareStatus) return;
    const timer = window.setTimeout(() => setShareStatus(''), 5000);
    return () => window.clearTimeout(timer);
  }, [shareStatus]);

  useEffect(() => {
    const engine = new GeometryPipeline(
      () => new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' }), {
        pending: () => { setBusy(true); setError(''); },
        result: (result, renderedScene, current, startedAt) => {
          viewport.current?.setGeometry(result, renderedScene, startedAt);
          if (fitPending.current && current && result.quality === 'final') { viewport.current?.fitView(); fitPending.current = false; }
          setMetrics(result); setDisplayQuality(result.quality); setError('');
          setBusy(!(current && result.quality === 'final'));
        },
        error: message => { setBusy(false); setError(message); },
      });
    pipeline.current = engine;
    engine.update(sceneRef.current);
    return () => { engine.dispose(); pipeline.current = null; };
  }, [engineRestart]);

  useEffect(() => {
    viewport.current?.setScene(scene);
    pipeline.current?.update(scene);
  }, [scene]);

  useEffect(() => { viewport.current?.setOptions(selected, tool, reveals, locked, snap, panel === 'shape' || panel === 'deform', display); }, [selected, tool, reveals, locked, snap, panel, display]);
  useEffect(() => { viewport.current?.setCurveEditor(curveEditing, curvePoint); }, [curveEditing, curvePoint]);

  useEffect(() => { if (locked) { setPanel('draw'); setCurveEditing(false); } }, [locked]);
  useEffect(() => { panelBody.current?.scrollTo(0, 0); }, [panel]);

  useEffect(() => { if (scene.operation === 'single') setSelected('a'); }, [scene.operation]);

  const undo = useCallback(() => {
    const previous = past.at(-1); if (!previous || dragging) return;
    const current = cloneScene(sceneRef.current);
    setFuture(values => [current, ...values]); setPast(past.slice(0, -1));
    edit(cloneScene(previous)); committed.current = cloneScene(previous);
    const template = matchingPreset(previous); setPreset(template);
  }, [past, dragging, edit]);
  const redo = useCallback(() => {
    const next = future[0]; if (!next || dragging) return;
    const current = cloneScene(sceneRef.current);
    setPast(values => [...values, current]); setFuture(future.slice(1));
    edit(cloneScene(next)); committed.current = cloneScene(next);
    const template = matchingPreset(next); setPreset(template);
  }, [future, dragging, edit]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (manualLink) {
        if (event.key === 'Escape') { setManualLink(null); shareButton.current?.focus(); }
        if (event.key === 'Tab') {
          const controls = [...document.querySelectorAll<HTMLElement>('.share-dialog button, .share-dialog input')];
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
        return;
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === 'Escape') { viewport.current?.cancelDrag(); setHelp(false); setExported(null); setFocus(false); }
      if (help || exported) {
        if (event.key === 'Tab') {
          const controls = [...document.querySelectorAll<HTMLElement>('.help-dialog button, .image-dialog button, .image-dialog a')];
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'z') { event.preventDefault(); if (!locked) event.shiftKey ? redo() : undo(); }
        return;
      }
      if (event.key.toLowerCase() === 'h') setReveals(value => ({ ...value, hidden: !value.hidden }));
      if (event.key === ' ') { event.preventDefault(); setLocked(value => !value); }
      if (!locked) {
        if (event.key.toLowerCase() === 'w') { setTool('translate'); setCurveEditing(false); setPanel('shape'); setControlsCollapsed(false); }
        if (event.key.toLowerCase() === 'e') { setTool('rotate'); setCurveEditing(false); setPanel('shape'); setControlsCollapsed(false); }
        if (event.key.toLowerCase() === 'r') { setTool('scale'); setCurveEditing(false); setPanel('shape'); setControlsCollapsed(false); }
      }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [locked, undo, redo, help, exported, manualLink]);

  function mutate(change: (next: SceneState) => void, commit = false) {
    const next = cloneScene(sceneRef.current); change(next); shapeEntries(next, true).forEach(([, shape]) => constrainBend(shape)); edit(next); if (commit) checkpoint();
  }
  function applyPreset(index: number) {
    fitPending.current = true;
    setPreset(index); generatedStudy.current = cloneScene(PRESETS[index].scene); edit(cloneScene(PRESETS[index].scene)); checkpoint();
    setSelected('a'); setLocked(false); setStage(null); setReveals({ ...INITIAL_REVEALS, construction: PRESETS[index].group !== 'Basics' }); viewport.current?.setView('perspective');
    setCurveEditing(false); setCurvePoint(2);
  }
  function newRounded() {
    fitPending.current = true;
    setPreset(-1); setSelected('a'); setStage(null); setCurveEditing(false); setCurvePoint(2); setReveals(INITIAL_REVEALS);
    const next = generateRounded(); generatedStudy.current = cloneScene(next);
    edit(next); checkpoint(); viewport.current?.setView('perspective');
  }
  function setKind(kind: ShapeKind) {
    setCurveEditing(false);
    mutate(next => {
      const previous = getShape(next, selected);
      Object.assign(previous, makeShape(kind), { position: previous.position, rotation: previous.rotation });
      delete previous.spine;
    }, true);
  }
  function addForm() {
    fitPending.current = true;
    mutate(next => { const id = addShape(next, addKind); if (display === 'forms') getShape(next, id).appearance = 'wireframe'; setSelected(id); }, true);
    setPreset(-1); setCurveEditing(false); setCurvePoint(2); selectPanel('shape');
  }
  function changeFormAppearance(mode: FormAppearance) {
    mutate(next => setFormAppearance(next, selected, mode, display), true);
    setDisplay('forms');
  }
  function removeForm() {
    fitPending.current = true;
    mutate(next => { setSelected(removeShape(next, selected)); }, true);
    setPreset(-1); setCurveEditing(false); setCurvePoint(2);
  }
  function revealStage(index: number) {
    setStage(index);
    setReveals(index === 0 ? { cutter: false, construction: false, hidden: false, seam: false }
      : index === 1 ? { cutter: true, construction: true, hidden: false, seam: true }
      : { cutter: true, construction: true, hidden: true, seam: true });
  }
  function toggleReveal(key: keyof Reveals) { setStage(null); setReveals(value => ({ ...value, [key]: !value[key] })); }
  function exportImage() {
    const image = viewport.current?.exportImage(); if (!image) return;
    setExported(image);
  }
  async function copyShareLink() {
    let link: string;
    try {
      // Read current parameters directly; refinement workers may still be busy.
      const hash = encodeStudy(readStudy.current());
      link = `${window.location.origin}${window.location.pathname}${window.location.search}${hash}`;
      pauseSharing.current = false; setLinkError(''); syncUrl(true);
    } catch { setShareStatus('This study could not be encoded. Check the form settings and try again.'); return; }
    try {
      await navigator.clipboard.writeText(link);
      setShareStatus('Share link copied.');
    } catch { setManualLink(link); setShareStatus(''); }
  }
  function closeShareDialog() { setManualLink(null); shareButton.current?.focus(); }
  const volumePercent = metrics ? Math.round((metrics.overlapVolume / metrics.bodyVolume) * 100) : 0;
  const statusMessage = error ? 'Geometry needs attention' : busy ? (displayQuality === 'preview' ? 'Live preview · refining detail…' : 'Updating geometry…') : display === 'solid' && metrics?.volume === 0 ? 'The result is empty — move or resize a shape.' : scene.operation !== 'single' && metrics && metrics.overlapVolume < .00001 ? 'No overlap with form A — move a form closer.' : 'Ready to study';

  const single = scene.operation === 'single';
  const curve = getShape(scene, selected).spine;
  const pointIndex = Math.min(curvePoint, (curve?.length ?? 1) - 1);
  const point = curve?.[pointIndex];
  const editingCurve = !!curve && curveEditing;
  function enableCurve() {
    mutate(next => { const shape = getShape(next, selected); shape.spine = curveFromShape(shape); shape.deform.bend = 0; }, true);
    setCurveEditing(true); setCurvePoint(2);
  }
  function movePoint(axis: number, value: number) {
    mutate(next => {
      const shape = getShape(next, selected), position = [...shape.spine![pointIndex].position] as Vec3;
      position[axis] = value / shape.size[axis];
      shape.spine![pointIndex].position = constrainCurvePoint(shape, pointIndex, position);
    });
  }
  function selectPanel(next: Panel) {
    setPanel(next); setControlsCollapsed(false);
    setCurveEditing(next === 'deform' && !!getShape(sceneRef.current, selected).spine);
  }
  function toggleDrawing() {
    setLocked(!locked); setControlsCollapsed(false);
    selectPanel(locked ? 'shape' : 'draw');
  }
  const revealControls = (keys: (keyof Reveals)[]) => keys.map(key => {
    const label = { cutter: 'Other form outlines', construction: 'Cross-contours', hidden: 'Hidden lines', seam: 'Connection edges' }[key];
    return <button key={key} className={reveals[key] ? 'active' : ''} aria-pressed={reveals[key]} disabled={single && (key === 'cutter' || key === 'seam')} onClick={() => toggleReveal(key)}><span className="toggle-check">{reveals[key] && <Check size={13} strokeWidth={3} />}</span>{label}</button>;
  });
  const formAppearanceControl = (location: Panel) => <section className="form-appearance" aria-label={`Form ${selected.toUpperCase()} appearance`}>
    <div className="section-caption">FORM {selected.toUpperCase()} VIEW</div>
    <div className="mode-tabs">{(['wireframe', 'solid'] as const).map(mode => <button key={mode} aria-label={`Form ${selected.toUpperCase()} ${mode}`} className={formAppearance(scene, selected, display) === mode ? 'active' : ''} aria-pressed={formAppearance(scene, selected, display) === mode} disabled={dragging} onClick={() => changeFormAppearance(mode)}>{mode === 'wireframe' ? 'Wireframe' : 'Solid'}</button>)}</div>
    {location === 'shape' && <p className="parameter-tip">Shows the original form. All wireframe below the drawing removes every filled surface.</p>}
  </section>;
  const formList = (location: Panel, editable = false) => <section className="form-list" aria-label="Forms in study">
    <div className="section-caption">FORMS IN YOUR STUDY<span>{forms.length} / {MAX_SHAPES}</span></div>
    <div className="shape-selector">{forms.map(([id, shape]) => <button key={id} className={selected === id ? 'active' : ''} onClick={() => { setSelected(id); setCurvePoint(2); }} disabled={locked || dragging} aria-pressed={selected === id}>
      <span className="form-letter">{id.toUpperCase()}</span><span>Form {id.toUpperCase()}<small>{shapeName(shape.kind)}</small></span></button>)}</div>
    {location === 'shape' && formAppearanceControl(location)}
    {editable && <><div className="add-form-row"><label className="sr-only" htmlFor={`add-kind-${location}`}>Shape to add</label><div className="select-wrap"><select id={`add-kind-${location}`} value={addKind} onChange={event => setAddKind(event.target.value as ShapeKind)} disabled={locked || dragging || forms.length >= MAX_SHAPES}>{SHAPES.map(shape => <option key={shape.id} value={shape.id}>{shape.label}</option>)}</select><ChevronDown size={14} /></div><button className="secondary-button" disabled={locked || dragging || forms.length >= MAX_SHAPES} onClick={addForm}><Plus size={16} /> Add form</button></div>
      {forms.length >= MAX_SHAPES && <p className="parameter-tip">All six forms are in use. Remove a form to add another.</p>}
      {!single && <button className="text-button remove-form" disabled={locked || dragging} onClick={removeForm}><Trash2 size={14} /> Remove form {selected.toUpperCase()}</button>}</>}
  </section>;
  return <div className={`app ${focus ? 'focus-mode' : ''} ${controlsCollapsed ? 'controls-collapsed' : ''}`}>
    <header className="app-header">
      <a className="brand" href="./" aria-label="Form Lab home"><span className="brand-symbol"><Box size={24} strokeWidth={1.5} /></span>Form Lab<span className="brand-dot">.</span></a>
      <span className="header-context">A space to understand form</span>
      <div className="header-actions">
        <button ref={shareButton} className="secondary-button share-button" onClick={copyShareLink} aria-label="Copy share link" title="Copy share link"><Link size={17} /><span>Share link</span></button>
        <button className="secondary-button export-button" onClick={exportImage} disabled={busy || !!error} aria-label="Save image" title="Save image"><ArrowDownToLine size={17} /><span>Save image</span></button>
        <button className={`primary-button ${locked ? 'locked' : ''}`} onClick={toggleDrawing} aria-pressed={locked}>{locked ? <UnlockKeyhole size={16} /> : <LockKeyhole size={16} />}<span>{locked ? 'Edit forms' : 'Start drawing'}</span></button>
      </div>
    </header>
    {linkError && <div className="link-notice" role="alert"><p><strong>Couldn’t open this shared study.</strong> {linkError}</p><button className="secondary-button" onClick={() => { pauseSharing.current = false; setLinkError(''); syncUrl(true); }}>Keep this study</button></div>}
    <div className={`share-status ${shareStatus ? 'visible' : ''}`} role="status" aria-live="polite">{shareStatus}</div>
    <main className="workspace">
      <section className="studio" aria-label="Drawing reference workspace">
        <div className="studio-toolbar">
          <div className="view-label"><span className={`live-dot ${busy ? 'busy' : ''}`} />{locked ? 'REFERENCE LOCKED' : 'YOUR REFERENCE'}</div>
          <div className="view-actions"><button className="icon-button" disabled={!past.length || dragging || locked} onClick={undo} title="Undo (⌘/Ctrl Z)" aria-label="Undo"><Undo2 size={18} /></button><button className="icon-button" disabled={!future.length || dragging || locked} onClick={redo} title="Redo (⌘/Ctrl Shift Z)" aria-label="Redo"><Redo2 size={18} /></button><button className="icon-button" onClick={() => setHelp(true)} aria-label="Open controls help" title="Controls & shortcuts"><HelpCircle size={18} /></button><button className="icon-button focus-button" onClick={() => setFocus(!focus)} aria-label={focus ? 'Exit focus mode' : 'Focus mode'} title={focus ? 'Show controls' : 'Hide controls'}>{focus ? <X size={18} /> : <Maximize2 size={18} />}</button></div>
        </div>
        <div className="camera-row"><span className="canvas-caption">{single ? shapeName(scene.a.kind) : `${forms.length} forms · ${OPERATIONS.find(item => item.id === scene.operation)?.label}`}</span>
          <div className="view-presets" aria-label="Camera views">{(['perspective', 'front', 'side', 'top'] as const).map(view => <button key={view} disabled={locked} onClick={() => viewport.current?.setView(view)}>{view === 'perspective' ? '3D' : view}</button>)}<button disabled={locked} title="Fit forms to view" aria-label="Fit forms to view" onClick={() => viewport.current?.fitView()}><Focus size={17} /></button></div>
        </div>
        <div className="canvas-container" ref={containerRef} />
        <div className="canvas-hint">{locked ? <><LockKeyhole size={14} /> Reference locked. Reveal lines as you draw.</> : editingCurve ? <>Tap a point · Drag its arrows or use the sliders</> : <><MousePointer2 size={14} /><span className="mouse-hint">Drag to orbit · Scroll to zoom · Right-drag to pan</span><span className="touch-hint">Drag to orbit · Pinch to zoom · Two fingers to pan</span></>}</div>
        {error && <div className="error-message" role="alert"><strong>Let’s recover this view.</strong><p>{error}</p><button onClick={() => { setError(''); setEngineRestart(value => value + 1); }}>Retry geometry</button><button onClick={() => applyPreset(0)}>Reset forms</button></div>}
        <div className="reveal-bar" aria-label="Quick drawing guides"><button className={wireframe ? 'active' : ''} aria-pressed={wireframe} onClick={() => setDisplay(wireframe ? (display === 'wireframe' && forms.some(([, shape]) => shape.appearance === 'solid') ? 'forms' : 'solid') : 'wireframe')}><span className="toggle-check">{wireframe && <Check size={13} strokeWidth={3} />}</span>All wireframe</button>{revealControls(single ? ['construction'] : ['seam'])}<button className="more-guides" aria-label="All drawing guides" title="All drawing guides" onClick={() => { setFocus(false); selectPanel('draw'); }}><Layers3 size={16} /><span>All guides</span></button></div>
      </section>
      <aside className="inspector" aria-label="Study controls">
        <div className="inspector-navigation"><div className="workflow-tabs" role="tablist" aria-label="Study workflow">{PANELS.map((item, index) => <button key={item.id} id={`tab-${item.id}`} role="tab" aria-selected={panel === item.id} aria-controls={`panel-${item.id}`} tabIndex={panel === item.id ? 0 : -1} disabled={dragging} onClick={() => selectPanel(item.id)} onKeyDown={event => {
          const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!offset && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? PANELS.length - 1 : (index + offset + PANELS.length) % PANELS.length;
          selectPanel(PANELS[next].id); document.getElementById(`tab-${PANELS[next].id}`)?.focus({ preventScroll: true });
        }}><span className="workflow-number">{index + 1}</span>{item.label}</button>)}</div>
        <button className="collapse-controls" onClick={() => setControlsCollapsed(!controlsCollapsed)} aria-expanded={!controlsCollapsed} aria-controls="controls-body" aria-label={controlsCollapsed ? 'Show controls' : 'Hide controls'}>{controlsCollapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button></div>
        <div className="inspector-body" id="controls-body" ref={panelBody}>
          {locked && <div className="lock-note"><LockKeyhole size={17} /><span>Your reference is locked for drawing.</span><button onClick={toggleDrawing}>Edit forms</button></div>}
          <section id="panel-study" role="tabpanel" aria-labelledby="tab-study" hidden={panel !== 'study'}>
            <div className="panel-heading"><span className="eyebrow">01 / START HERE</span><h1>Choose your study.</h1><p>Start with a basic shape, then explore combinations and flowing forms.</p></div>
        <div className="study-selector"><label htmlFor="study">Choose a starting point</label><div className="select-wrap"><select id="study" value={preset} onChange={e => applyPreset(Number(e.target.value))} disabled={locked || dragging}>{preset === -1 && <option value={-1}>Custom study</option>}{(['Basics', 'Form manipulation', 'Combinations'] as const).map(group => <optgroup key={group} label={group}>{PRESETS.map((p, i) => p.group === group && <option key={p.name} value={i}>{p.name}</option>)}</optgroup>)}</select><ChevronDown size={14} /></div>
          <button className="generator-button" disabled={locked || dragging} onClick={newRounded}><Shuffle size={14} /> New rounded form</button>
        </div>
        <div className="mode-tabs" aria-label="Study mode">{[{ id: 'single', label: 'Single form' }, { id: 'union', label: 'Combine forms' }].map(mode => <button key={mode.id} disabled={locked || dragging} aria-pressed={single === (mode.id === 'single')} className={single === (mode.id === 'single') ? 'active' : ''} onClick={() => { fitPending.current = true; mutate(next => { next.operation = mode.id as Operation; }, true); setSelected('a'); }}>{mode.label}</button>)}</div>

            {!single && formList('study', true)}
            <fieldset disabled={locked || dragging}><legend className="sr-only">Combine forms</legend>
          {!single && <div className="operation-section"><div className="section-caption">HOW THE FORMS COMBINE</div><div className="operation-grid">{OPERATIONS.filter(operation => operation.id !== 'single').map(operation => <button key={operation.id} className={scene.operation === operation.id ? 'active' : ''} aria-pressed={scene.operation === operation.id} title={operation.description} onClick={() => mutate(next => { next.operation = operation.id; }, true)}><span>{operation.symbol}</span>{operation.label}</button>)}</div><p>{OPERATIONS.find(item => item.id === scene.operation)?.description}.</p></div>}

            </fieldset><p className="parameter-tip">{single ? 'Study one volume, or combine forms to practice their connections.' : 'Form A is the main solid. The other forms join it, overlap it, or cut into it.'}</p>
            <button className="primary-button next-step" onClick={() => selectPanel('shape')}>Adjust shape <ArrowRight size={17} /></button>
          </section>
          <section id="panel-shape" role="tabpanel" aria-labelledby="tab-shape" hidden={panel !== 'shape'}>
            <div className="panel-heading"><span className="eyebrow">02 / BUILD THE FORM</span><h2>Size & position.</h2><p>Choose a form, then adjust its proportions and placement.</p></div>
        {formList('shape', true)}

            <fieldset disabled={locked || dragging}><legend className="sr-only">Shape editing controls</legend>
          <label className="shape-kind" htmlFor="shape-kind">{single ? 'SHAPE' : `FORM ${selected.toUpperCase()} SHAPE`}</label><div className="select-wrap"><select id="shape-kind" value={getShape(scene, selected).kind} onChange={e => setKind(e.target.value as ShapeKind)}>{SHAPES.map(shape => <option value={shape.id} key={shape.id}>{shape.label}</option>)}</select><ChevronDown size={14} /></div>
          <div className="tool-tabs">{([{ id: 'scale', label: 'Size', icon: Maximize2 }, { id: 'translate', label: 'Move', icon: Move3D }, { id: 'rotate', label: 'Rotate', icon: Rotate3D }] as const).map(({ id, label, icon: Icon }) => <button key={id} onClick={() => { setTool(id); setCurveEditing(false); }} className={!editingCurve && tool === id ? 'active' : ''} aria-pressed={!editingCurve && tool === id}><Icon size={15} />{label}</button>)}</div>
          <div className="parameter-section"><div className="section-caption">{tool === 'translate' ? 'POSITION' : tool === 'rotate' ? 'ROTATION' : 'DIMENSIONS'}<span>{tool === 'rotate' ? 'degrees' : 'relative units'}</span></div>
            {tool !== 'scale' ? (['X', 'Y', 'Z'] as const).map((axis, index) => <Slider key={`${selected}-${tool}-${axis}`} label={`${axis} ${tool === 'translate' ? 'position' : 'rotation'}`} value={getShape(scene, selected)[tool === 'translate' ? 'position' : 'rotation'][index]} min={tool === 'translate' ? -5 : -180} max={tool === 'translate' ? 5 : 180} step={tool === 'translate' ? .05 : 1} suffix={tool === 'rotate' ? '°' : ''} disabled={locked || dragging} onChange={v => mutate(next => { getShape(next, selected)[tool === 'translate' ? 'position' : 'rotation'][index] = v; })} onCommit={checkpoint} />)
              : ['Width', 'Height', 'Length'].map((name, index) => <Slider key={`${selected}-${name}`} label={name} value={getShape(scene, selected).size[index]} min={.4} max={12} disabled={locked || dragging} onChange={v => mutate(next => { getShape(next, selected).size[index] = v; })} onCommit={checkpoint} />)}

            <label className="snap-control"><input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)} /><span>Snap handles to steps</span><small>{editingCurve ? '0.25' : tool === 'rotate' ? '15°' : tool === 'scale' ? '0.1' : '0.25'}</small></label>
          </div>

            </fieldset><button className="primary-button next-step" onClick={() => selectPanel('deform')}>Bend & twist <ArrowRight size={17} /></button>
          </section>
          <section id="panel-deform" role="tabpanel" aria-labelledby="tab-deform" hidden={panel !== 'deform'}>
            <div className="panel-heading"><span className="eyebrow">03 / EXPLORE THE VOLUME</span><h2>Bend, twist & flow.</h2><p>Shape the centerline and thickness, or transform the whole volume.</p></div>
        {formList('deform', false)}

            <fieldset disabled={locked || dragging}><legend className="sr-only">Deformation controls</legend>
          {getShape(scene, selected).kind === 'rounded' && <section className="curve-editor" aria-label="Centerline editor">
            <div className="section-caption">CENTERLINE<span>{curve ? `${curve.length} points` : 'Shape the flow'}</span></div>
            {!curve ? <><p className="parameter-tip">Bend in more than one direction and vary the thickness along the form.</p><button className="generator-button" onClick={enableCurve}>Enable control points</button></> : <>
              <div className="mode-tabs curve-mode"><button aria-pressed={curveEditing} className={curveEditing ? 'active' : ''} onClick={() => setCurveEditing(true)}>Edit curve</button><button aria-pressed={!curveEditing} className={!curveEditing ? 'active' : ''} onClick={() => setCurveEditing(false)}>Whole form</button></div>
              {curveEditing && point && <>
                <div className="point-selector" aria-label="Curve points">{curve.map((_, index) => <button key={index} aria-label={`Edit point ${index + 1}`} aria-pressed={pointIndex === index} className={pointIndex === index ? 'active' : ''} onClick={() => setCurvePoint(index)}>{index + 1}</button>)}</div>
                <p className="parameter-tip">Point {pointIndex + 1} of {curve.length}. Adjust its position and thickness.</p>
                <Slider label="Point thickness" min={20} max={180} step={1} suffix="%" value={point.radius * 100} disabled={locked || dragging} onChange={v => mutate(next => { getShape(next, selected).spine![pointIndex].radius = v / 100; })} onCommit={checkpoint} />
                {(['Across', 'Depth', 'Along'] as const).map((label, axis) => {
                  const shape = getShape(scene, selected), end = pointIndex === 0 || pointIndex === curve.length - 1;
                  const span = Math.floor(curveOffsetLimit(shape, axis) * shape.size[axis] * 100) / 100;
                  const min = axis < 2 ? -span : end ? -shape.size[2] / 2 : Math.ceil((curve[pointIndex - 1].position[2] + CURVE_GAP) * shape.size[2] * 100) / 100;
                  const max = axis < 2 ? span : end ? shape.size[2] / 2 : Math.floor((curve[pointIndex + 1].position[2] - CURVE_GAP) * shape.size[2] * 100) / 100;
                  return <Slider key={`${selected}-${pointIndex}-${axis}`} label={`Point ${label.toLowerCase()}`} min={min} max={max} step={.01} value={point.position[axis] * shape.size[axis]} disabled={locked || dragging || (axis === 2 && end)} onChange={v => movePoint(axis, v)} onCommit={checkpoint} />;
                })}
                <p className="parameter-tip">End points keep their length position. Use Length in Shape to stretch the form. Tight bends need thinner sections.</p>
              </>}
              <button className="text-button" onClick={() => mutate(next => { getShape(next, selected).spine!.forEach(p => { p.position[0] = p.position[1] = 0; }); }, true)}><RotateCcw size={12} /> Straighten centerline</button>
              <button className="text-button" onClick={() => { mutate(next => { delete getShape(next, selected).spine; }, true); setCurveEditing(false); }}>Return to arc bend</button>
            </>}
          </section>}
          <details className="deform-section" open={!editingCurve}><summary>Deform the volume</summary><p className="parameter-tip">{curve ? 'Twist and profile controls combine with your centerline and local thickness.' : 'Along the form’s own length (Z). Combine controls to explore new volumes.'}</p>
          {([
            { key: 'twist', label: 'Twist', min: -180, max: 180, step: 1, suffix: '°' },
            { key: 'bend', label: 'Bend', min: -bendLimit(getShape(scene, selected)), max: bendLimit(getShape(scene, selected)), step: 1, suffix: '°' },
            { key: 'taper', label: 'Taper', min: -1.2, max: 1.2, step: .05, suffix: '' },
            { key: 'bulge', label: 'Bulge / pinch', min: -.65, max: .7, step: .05, suffix: '' },
            { key: 'roundness', label: 'Roundness', min: 0, max: 1, step: .05, suffix: '' },
          ] as const).filter(control => !(curve && control.key === 'bend')).map(control => <Slider key={`${selected}-${control.key}`} label={control.label} min={control.min} max={control.max} step={control.step} suffix={control.suffix} value={getShape(scene, selected).deform[control.key]} disabled={locked || dragging} onChange={v => mutate(next => { getShape(next, selected).deform[control.key as keyof Deformation] = v; })} onCommit={checkpoint} />)}
          <p className="parameter-tip">Roundness: 0 = square, 1 = round. Bend range adjusts to the width to keep the form from folding through itself.</p>
          <button className="text-button" onClick={() => mutate(next => { getShape(next, selected).deform = makeShape(getShape(next, selected).kind).deform; }, true)}><RotateCcw size={12} /> Clear deformations</button></details>

            </fieldset><button className="primary-button next-step" onClick={() => selectPanel('draw')}>Set up drawing guides <ArrowRight size={17} /></button>
          </section>
          <section id="panel-draw" role="tabpanel" aria-labelledby="tab-draw" hidden={panel !== 'draw'}>
            <div className="panel-heading"><span className="eyebrow">04 / PUT PEN TO PAPER</span><h2>Look. Draw. Reveal.</h2><p>Draw what you see, then check the lines that explain the volume.</p></div>
            <section className="display-options" aria-label="Reference appearance"><h3>Reference view</h3>
              <div className="mode-tabs">{(['solid', 'forms', 'wireframe'] as const).map(mode => <button key={mode} className={display === mode ? 'active' : ''} aria-pressed={display === mode} onClick={() => setDisplay(mode)}>{mode === 'solid' ? 'Solid result' : mode === 'forms' ? 'Per form' : 'All wireframe'}</button>)}</div>
              <p className="parameter-tip">{display === 'forms' ? 'Original forms with individual surfaces. Choose a form in Shape to change its view; connection lines mark exposed joins across all forms.' : wireframe ? 'Only the edges of each original form. No filled faces or shading; front and back edges are equally visible.' : 'Shaded surfaces show the combined result. Reveal hidden edges to see through the solid.'}</p>
            </section>
        <div className="lesson-steps">{[
          ['Observe', single ? 'Draw the silhouette. Predict how a contour wraps around it.' : 'Draw the silhouette. Predict where the forms intersect.'],
          ['Construct', 'Follow the centerline. Notice how each cross-section turns with the bend.'],
          ['Reveal', wireframe ? 'Check the cross-contours and where the forms connect.' : 'Follow the hidden edges. Compare near and far curves.'],
        ].map(([title, description], index) => <button key={title} className={`lesson-step ${stage === index ? 'active' : ''}`} onClick={() => revealStage(index)} aria-pressed={stage === index}>
          <span className="step-number">0{index + 1}</span><span><strong>{title}</strong><small>{description}</small></span><ArrowRight className="step-arrow" size={14} />
        </button>)}</div>

            <section className="drawing-guides" aria-label="Drawing guides"><h3>Choose what to reveal</h3><div className="guide-toggles">{revealControls(wireframe ? (single ? ['construction'] : ['construction', 'seam']) : (single ? ['construction', 'hidden'] : ['construction', 'hidden', ...(display === 'solid' ? ['cutter' as const] : []), 'seam']))}</div>
        {!single && <p className="connection-hint">{reveals.seam ? 'Green lines mark exposed joins across all forms. Connections buried inside another form are omitted.' : 'Draw the exposed joins between all forms, then turn on Connection edges to check.'}</p>}
        <div className="contour-density"><Slider label="Cross-contour count" value={scene.contours} min={1} max={9} step={1} disabled={dragging} onChange={v => { mutate(next => { next.contours = Math.round(v); }); setReveals(value => ({ ...value, construction: true })); }} onCommit={checkpoint} /><p className="parameter-tip">Use fewer sections to practice placing each line with intent.</p></div>

            </section><p className="guide-note">{single ? 'Start with 3–5 cross-contours. Their tilt follows the direction of the form.' : 'Construction lines show the original forms, including the parts removed by a cut.'}</p>
            <button className="secondary-button" disabled={locked} onClick={() => viewport.current?.restoreView()}><Focus size={16} /> Return to saved drawing view</button>
            <div className="line-legend"><span><i className="legend-solid" /> {wireframe ? 'Form edges' : 'Visible'}</span>{!wireframe && <span><i className="legend-hidden" /> Hidden</span>}<span><i className="legend-seam" /> Intersection</span></div>
          </section>
          <div className="panel-footer"><button className="text-button" onClick={() => setHelp(true)}><HelpCircle size={16} /> Controls & help</button>{panel !== 'draw' && <button className="text-button" disabled={locked || dragging} onClick={() => { edit(cloneScene(PRESETS[preset]?.scene ?? generatedStudy.current)); checkpoint(); }}><RotateCcw size={15} /> Reset study</button>}</div>
        </div>
      </aside>
    </main>
    <footer className="status-bar"><span className={error ? 'status-error' : ''}><span className={`live-dot ${busy ? 'busy' : ''}`} />{statusMessage}</span><span className="geometry-stats">{metrics && !busy && !error ? `${single ? 'Single form' : `${volumePercent}% of A shared`} · ${Math.round(metrics.duration)} ms` : 'Form studies'}</span></footer>
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e => e.stopPropagation()}><button autoFocus className="icon-button close-dialog" aria-label="Close help" onClick={() => setHelp(false)}><X size={18} /></button><div className="eyebrow">A FEW SIMPLE CONTROLS</div><h2 id="help-title">Make yourself at home.</h2><p>Start in Study, adjust size and position in Shape, then bend or twist in Deform. Open Draw for step-by-step practice. Use Deform to twist, bend, taper, pinch, or morph the cross-section. Add up to six forms from Shape. Select a form to edit it, or remove it from the study. Use All wireframe for transparent forms with every edge visible. In Shape, choose Solid or Wireframe for the selected form. Per form shows the original shapes; Solid result shows the chosen cut or join. Cross-contours and connection edges can be revealed independently. Connection edges cover all forms and omit seams buried inside another form. Solid view also offers hidden-line reveals.</p><dl><dt>Orbit / zoom</dt><dd>Drag / scroll or pinch</dd><dt>Pan</dt><dd>Right-drag · two-finger drag</dd><dt>Move / rotate / size</dt><dd><kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd></dd><dt>Lock / unlock drawing view</dt><dd><kbd>Space</kbd></dd><dt>Reveal hidden lines (Solid view)</dt><dd><kbd>H</kbd></dd><dt>Undo / redo</dt><dd><kbd>⌘ / Ctrl</kbd> + <kbd>Z</kbd> / <kbd>Shift Z</kbd></dd></dl><p className="help-footnote">Use Start drawing to keep the reference still. Save image exports a clean view without the editing handles. The address keeps your current forms and view. Copy share link to reopen or share this study; undo history stays in this visit.</p><button className="primary-button" onClick={() => setHelp(false)}>Got it <ArrowRight size={15} /></button></section></div>}
    {manualLink && <div className="modal-backdrop" onClick={closeShareDialog}><section className="help-dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title" onClick={e => e.stopPropagation()}><button className="icon-button close-dialog" aria-label="Close share link" onClick={closeShareDialog}><X size={18} /></button><div className="eyebrow">TAKE YOUR STUDY WITH YOU</div><h2 id="share-title">Copy your share link.</h2><p>Your browser couldn’t copy automatically. Select the link and copy it with ⌘/Ctrl+C.</p><label className="share-link-label">Share link<input autoFocus readOnly value={manualLink} onFocus={e => e.currentTarget.select()} /></label><button className="primary-button" onClick={closeShareDialog}>Done <Check size={15} /></button></section></div>}
    {exported && <div className="modal-backdrop" onClick={() => setExported(null)}><section className="image-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" onClick={e => e.stopPropagation()}><button autoFocus className="icon-button close-dialog" aria-label="Close image preview" onClick={() => setExported(null)}><X size={18} /></button><div className="eyebrow">YOUR DRAWING REFERENCE</div><h2 id="export-title">Take this study with you.</h2><img src={exported} alt="Exported study without editing handles" /><p>PNG · 2× resolution · current construction reveals</p><a className="primary-button" href={exported} download="form-lab-study.png"><ArrowDownToLine size={15} /> Download PNG</a></section></div>}
  </div>;
}
