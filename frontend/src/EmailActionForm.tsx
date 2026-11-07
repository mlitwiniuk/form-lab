import { useState, type FormEvent } from 'react';
import { type AccountAction } from './account-links';
import { errorMessage, request } from './library';
export function EmailActionForm({ action, completed, back }: { action: AccountAction; completed: (purpose: AccountAction['purpose']) => Promise<void>; back: () => void }) {
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const valid = /^[a-f0-9]{64}$/i.test(action.token);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    if (action.purpose !== 'email' && data.get('new_password') !== data.get('confirm_password')) { setError('The passwords do not match.'); return; }
    setPending(true); setError('');
    try {
      const path = action.purpose === 'signup' ? 'register/complete' : action.purpose === 'reset' ? 'recovery/complete' : 'email/complete';
      await request(path, 'POST', { token: action.token, new_password: data.get('new_password') ?? '' });
      await completed(action.purpose);
    } catch (error) { setError(errorMessage(error)); } finally { setPending(false); }
  }
  return <>
    <p className="dialog-intro">{action.purpose === 'signup' ? 'Your email link is ready. Choose a password to finish creating your account.' : action.purpose === 'reset' ? 'Choose a new password. Resetting it will sign out your existing browser and device sessions.' : 'Confirm this address for the account where you requested it. You will then sign in again using this email.'}</p>
    {(!valid || error) && <p className="account-error" role="alert">{error || 'This email link is incomplete. Please request a new one.'}</p>}
    <form className="account-form" onSubmit={submit}><fieldset disabled={!valid || pending}>
      {action.purpose !== 'email' && <><label>{action.purpose === 'signup' ? 'Password' : 'New password'}<input type="password" name="new_password" minLength={12} maxLength={1024} required autoComplete="new-password" autoFocus /></label><label>Confirm password<input type="password" name="confirm_password" minLength={12} maxLength={1024} required autoComplete="new-password" /></label><p className="parameter-tip">Use at least 12 characters.</p></>}
      <button className="primary-button full-width" type="submit">{pending ? 'Please wait…' : action.purpose === 'signup' ? 'Create account' : action.purpose === 'reset' ? 'Reset password' : 'Confirm email'}</button>
    </fieldset></form><button className="text-button" disabled={pending} onClick={back}>Back to sign in / request a new link</button>
  </>;
}
