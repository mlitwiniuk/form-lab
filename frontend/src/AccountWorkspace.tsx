import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BookOpen, Box, Check, LogIn, Save, UserRound, X } from 'lucide-react';
import { ApiError, configurationUrl, errorMessage, request, type SavedConfiguration, type SaveKind } from './library';

function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => { node.close(); }; }, []);
  return <dialog className="account-dialog" ref={dialog} onCancel={close} onClose={close} aria-labelledby="workspace-dialog-title">
    <div className="dialog-heading"><h2 id="workspace-dialog-title">{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={20} /></button></div>{children}
  </dialog>;
}
type View = 'auth' | 'account' | 'library' | 'save' | null;
interface Props { kind: SaveKind; capture: () => unknown | Promise<unknown>; restore: (settings: unknown) => void | Promise<void>; disabled?: boolean; restoreReady?: boolean; children: ReactNode }
export function WorkspaceHeader({ kind, capture, restore, disabled, restoreReady = true, children }: Props) {
  const [user, setUser] = useState<string | null>(null), [available, setAvailable] = useState(true), [checking, setChecking] = useState(true);
  const [view, setView] = useState<View>(null), [signup, setSignup] = useState(false), [register, setRegister] = useState(false);
  const [pending, setPending] = useState(false), [message, setMessage] = useState(''), [notice, setNotice] = useState('');
  const [saves, setSaves] = useState<SavedConfiguration[]>([]), [selected, setSelected] = useState<SavedConfiguration | null>(null);
  const [title, setTitle] = useState(''), [overwrite, setOverwrite] = useState(false), [filter, setFilter] = useState<'all' | SaveKind>('all');
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const captureRef = useRef(capture), restoreRef = useRef(restore); captureRef.current = capture; restoreRef.current = restore;
  const userRef = useRef(user); userRef.current = user;
  const initialSave = useRef(new URLSearchParams(location.search).get('save'));
  const sessionVersion = useRef(0);
  const initialOpened = useRef(false), afterSignIn = useRef<View>(null);
  const close = useCallback(() => { setView(null); setMessage(''); setConfirmation(null); }, []);
  const clearSession = useCallback(() => { sessionVersion.current++; userRef.current = null; setUser(null); setSaves([]); setSelected(null); }, []);
  const refreshUser = useCallback(async () => {
    const version = sessionVersion.current;
    try { const me = await request<{ username: string }>('me'); if (version !== sessionVersion.current) return null; if (userRef.current !== me.username) { setSelected(null); setSaves([]); } userRef.current = me.username; setUser(me.username); setAvailable(true); return me.username; }
    catch (error) { if (version !== sessionVersion.current) return null; clearSession(); setAvailable(error instanceof ApiError && error.status === 401); return null; }
    finally { setChecking(false); }
  }, [clearSession]);
  const list = useCallback(async () => { const owner = userRef.current; const rows = await request<SavedConfiguration[]>('configurations'); if (owner === userRef.current) setSaves(rows); return rows; }, []);
  useEffect(() => { void refreshUser(); void request<{signup_enabled: boolean}>('account-options').then(options => setSignup(options.signup_enabled)).catch(() => {}); }, [refreshUser]);
  useEffect(() => { if (!checking && !user && view && view !== 'auth') setView('auth'); }, [checking, user, view]);
  // Recheck after returning from the other tool or another tab; never retain another account's saves.
  useEffect(() => { const focus = () => { void refreshUser(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [refreshUser]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer); }, [notice]);
  function fail(error: unknown) {
    if (error instanceof ApiError && error.status === 401) { clearSession(); setView('auth'); }
    setMessage(errorMessage(error));
  }
  function rememberSave(save: SavedConfiguration) {
    const url = new URL(location.href); url.searchParams.set('save', save.id); history.replaceState(history.state, '', url);
  }
  async function openSaved(save: SavedConfiguration) {
    if (save.kind !== kind) { location.assign(configurationUrl(save)); return; }
    const owner = userRef.current;
    await restoreRef.current(save.settings); if (owner !== userRef.current) throw new Error('Your account changed. Reopen the save from your library.'); setSelected(save); setTitle(save.title); close(); setNotice(`Opened “${save.title}”.`);
    // Retain the selected save across refreshes; public Share links strip this identifier.
    rememberSave(save);
  }
  useEffect(() => {
    if (checking || !initialSave.current || initialOpened.current || !restoreReady) return;
    if (!user) { setView('auth'); setMessage('Sign in to open this saved reference.'); return; }
    initialOpened.current = true; setPending(true);
    void request<SavedConfiguration>(`configurations/${encodeURIComponent(initialSave.current)}`).then(openSaved).catch(fail).finally(() => setPending(false));
  }, [checking, user, restoreReady]); // Capture/restore callbacks are read through refs.
  async function show(next: View) {
    setMessage(''); setConfirmation(null);
    if (!user) { afterSignIn.current = next === 'auth' ? null : next; setRegister(false); setView('auth'); return; }
    setView(next);
    if (next === 'library') { setPending(true); try { await list(); } catch (error) { fail(error); } finally { setPending(false); } }
    if (next === 'save') { setTitle(selected?.title ?? ''); setOverwrite(!!selected); }
  }
  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
    if (register && data.get('password') !== data.get('confirm_password')) { setMessage('The passwords do not match.'); return; }
    setPending(true); setMessage('');
    try {
      await request(register ? 'register' : 'login', 'POST', Object.fromEntries(data));
      form.reset(); sessionVersion.current++; await refreshUser(); close();
      const next = afterSignIn.current; afterSignIn.current = null;
      if (next === 'library') { setView('library'); await list(); }
      if (next === 'save') { setTitle(''); setOverwrite(false); setView('save'); }
      setNotice(register ? 'Your account is ready. Save your first reference.' : 'Signed in. Your library is ready.');
    } catch (error) { setMessage(error instanceof ApiError && error.status === 401 ? 'Username or password is incorrect.' : errorMessage(error)); }
    finally { setPending(false); }
  }
  async function saveCurrent(event: FormEvent) {
    event.preventDefault(); if (!title.trim()) return;
    const owner = userRef.current; setPending(true); setMessage('');
    try {
      const settings = await captureRef.current();
      if (owner !== userRef.current) throw new Error('Your account changed. Sign in again before saving.');
      const target = overwrite ? selected : null;
      const saved = await request<SavedConfiguration>(target ? `configurations/${encodeURIComponent(target.id)}` : 'configurations', target ? 'PUT' : 'POST',
        { title: title.trim(), kind, settings, ...(target ? { expected_revision: target.revision } : {}) });
      setSelected(saved); rememberSave(saved); close(); setNotice(target ? `Updated “${saved.title}”.` : `Saved “${saved.title}” to your library.`);
    } catch (error) { fail(error); } finally { setPending(false); }
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
    if (data.get('new_password') !== data.get('confirm_password')) { setMessage('The new passwords do not match.'); return; }
    setPending(true); setMessage('');
    try { await request('password', 'POST', Object.fromEntries(data)); form.reset(); setNotice('Password updated. Other sessions have been signed out.'); close(); }
    catch (error) { if (error instanceof ApiError && error.status === 401) setMessage('Current password is incorrect, or your session has ended.'); else fail(error); }
    finally { setPending(false); }
  }
  return <>
    <header className="app-header workspace-header">
      <a className="brand" href="/" aria-label="Form Lab home"><span className="brand-symbol"><Box size={24} strokeWidth={1.5} /></span>Form Lab<span className="brand-dot">.</span></a>
      <nav className="workspace-switch" aria-label="Reference tools"><a href="/" aria-current={kind === 'study' ? 'page' : undefined}>Form studies</a><a href="/sketchfab/" aria-current={kind === 'sketchfab' ? 'page' : undefined}>Sketchfab</a></nav>
      <div className="header-actions">{children}<button className="secondary-button" onClick={() => void show('save')} disabled={disabled || checking}><Save size={16} /><span>Save</span></button><button className="secondary-button" onClick={() => void show('library')} disabled={checking}><BookOpen size={16} /><span>Library</span></button><button className="secondary-button account-trigger" onClick={() => void show(user ? 'account' : 'auth')} disabled={checking}>{user ? <UserRound size={16} /> : <LogIn size={16} />}<span>{checking ? 'Checking…' : user ?? 'Sign in'}</span></button></div>
    </header>
    <div className={`share-status ${notice ? 'visible' : ''}`} role="status">{notice}</div>
    {view && <Modal title={view === 'auth' ? register ? 'Create your account.' : 'Welcome back.' : view === 'library' ? 'Your reference library.' : view === 'save' ? 'Keep this reference.' : 'Your account.'} close={close}>
      {message && <p className="account-error" role="alert">{message}</p>}
      {view === 'auth' && <>
        <p className="dialog-intro">One account for your form studies and Sketchfab references. Pick up where you left off on any device.</p>
        {!available && <p className="account-error">Accounts are unavailable at this address. You can still explore, export images and copy public view links.<button className="text-button" onClick={() => void refreshUser()}>Retry connection</button></p>}
        {signup && <div className="mode-tabs account-tabs"><button aria-pressed={!register} onClick={() => { setRegister(false); setMessage(''); }}>Sign in</button><button aria-pressed={register} onClick={() => { setRegister(true); setMessage(''); }}>Create account</button></div>}
        <form onSubmit={authenticate} key={String(register)} className="account-form"><fieldset disabled={pending || !available}>
          <label>Username<input name="username" required minLength={3} maxLength={40} autoComplete="username" autoCapitalize="none" spellCheck={false} pattern="[A-Za-z0-9_-]+" autoFocus /></label>
          <label>Password<input name="password" type="password" required minLength={register ? 12 : 1} maxLength={1024} autoComplete={register ? 'new-password' : 'current-password'} /></label>
          {register && <><label>Confirm password<input name="confirm_password" type="password" required minLength={12} autoComplete="new-password" /></label><label>Account creation key<input name="signup_key" type="password" required autoComplete="off" /></label><p className="parameter-tip">Use the key provided by the person hosting Form Lab. Choose a password with at least 12 characters.</p></>}
          <button className="primary-button full-width" type="submit">{pending ? 'Please wait…' : register ? 'Create account' : 'Sign in'}</button>
        </fieldset></form>
        {!signup && available && <p className="parameter-tip">Account creation is currently closed. Existing accounts can sign in.</p>}
        {!register && <p className="parameter-tip">Forgot your password? Contact the person hosting Form Lab. Email password recovery is not available.</p>}
      </>}
      {view === 'account' && <><p className="dialog-intro">Signed in as <strong>{user}</strong>. Your library is shared between both reference tools.</p><h3>Change password</h3><form className="account-form" onSubmit={changePassword}><fieldset disabled={pending}><label>Current password<input name="current_password" type="password" required autoComplete="current-password" /></label><label>New password<input name="new_password" type="password" required minLength={12} maxLength={1024} autoComplete="new-password" /></label><label>Confirm new password<input name="confirm_password" type="password" required minLength={12} autoComplete="new-password" /></label><p className="parameter-tip">Changing your password signs out your other browsers and devices.</p><button className="primary-button" type="submit">{pending ? 'Updating…' : 'Update password'}</button></fieldset></form><div className="account-footer"><button className="secondary-button" disabled={pending} onClick={async () => { setPending(true); try { await request('logout', 'POST', {}); clearSession(); close(); const url = new URL(location.href); url.searchParams.delete('save'); history.replaceState(history.state, '', url); setNotice('Signed out on this device.'); } catch (error) { fail(error); } finally { setPending(false); } }}>Sign out on this device</button></div></>}
      {view === 'save' && <form className="account-form" onSubmit={saveCurrent}><p className="dialog-intro">{kind === 'study' ? 'Save your forms, deformations, camera and drawing settings.' : 'Save this model, camera angle, projection and drawing settings.'}</p><fieldset disabled={pending}>
        <label>Name<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={120} placeholder={kind === 'study' ? 'e.g. Twisted form, side view' : 'e.g. Skull, three-quarter view'} autoFocus /></label>
        {selected && <div className="save-options"><label><input type="radio" name="save-mode" checked={overwrite} onChange={() => setOverwrite(true)} />Overwrite “{selected.title}”</label><label><input type="radio" name="save-mode" checked={!overwrite} onChange={() => setOverwrite(false)} />Save as new</label></div>}
        {!selected && <p className="parameter-tip">Creates a new save. Open a reference from your library to update that save later.</p>}
        <button className="primary-button full-width" type="submit"><Check size={16} />{pending ? 'Saving…' : overwrite && selected ? 'Overwrite save' : 'Save as new'}</button>
      </fieldset></form>}
      {view === 'library' && <><p className="dialog-intro">Your saved studies and model views, ready to reopen.</p><div className="mode-tabs account-tabs">{(['all', 'study', 'sketchfab'] as const).map(item => <button key={item} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item === 'all' ? 'All references' : item === 'study' ? 'Form studies' : 'Sketchfab'}</button>)}</div>
        {pending && <p role="status">Loading…</p>}
        {!pending && !saves.some(save => filter === 'all' || save.kind === filter) && <div className="library-empty"><BookOpen size={30} /><h3>A place for your next study.</h3><p>Arrange a reference, then choose Save. You can keep several views of the same model.</p></div>}
        <ul className="saved-list">{saves.filter(save => filter === 'all' || save.kind === filter).map(save => <li key={save.id}><button className="saved-open" disabled={pending} onClick={async () => { setPending(true); try { if (save.kind !== kind) location.assign(configurationUrl(save)); else await openSaved(await request<SavedConfiguration>(`configurations/${encodeURIComponent(save.id)}`)); } catch (error) { fail(error); } finally { setPending(false); } }}><span className="save-kind">{save.kind === 'study' ? 'FORM STUDY' : 'SKETCHFAB'}</span><strong>{save.title}</strong><span>Updated {new Date(save.updated_at * 1000).toLocaleDateString()}</span></button><div className="saved-delete">{confirmation === save.id ? <><span>Delete this save?</span><button className="text-button danger" disabled={pending} onClick={async () => { setPending(true); try { await request(`configurations/${encodeURIComponent(save.id)}`, 'DELETE'); if (selected?.id === save.id) { setSelected(null); const url = new URL(location.href); url.searchParams.delete('save'); history.replaceState(history.state, '', url); } await list(); setConfirmation(null); } catch (error) { fail(error); } finally { setPending(false); } }}>Delete</button><button className="text-button" onClick={() => setConfirmation(null)}>Keep</button></> : <button className="text-button" aria-label={`Delete ${save.title}`} onClick={() => setConfirmation(save.id)}>Delete</button>}</div></li>)}</ul>
      </>}
    </Modal>}
  </>;
}
