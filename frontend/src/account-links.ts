export type AccountAction = { purpose: 'signup' | 'reset' | 'email'; token: string };
let pending: AccountAction | null = null;
export function parseAccountLink(hash: string): AccountAction | null {
  const params = new URLSearchParams(hash.replace(/^#/, '')), purpose = params.get('account');
  if (!['signup', 'reset', 'email'].includes(purpose ?? '')) return null;
  return { purpose: purpose as AccountAction['purpose'], token: params.get('token') ?? '' };
}
/** Remove bearer tokens before rendering, share-state processing or third-party scripts. */
export function consumeAccountLink() {
  const action = parseAccountLink(window.location.hash);
  if (!action) return false;
  pending = action;
  const url = new URL(window.location.href); url.hash = ''; url.searchParams.delete('save');
  window.history.replaceState(window.history.state, '', url);
  return true;
}
export function takeAccountLink(): AccountAction | null { const action = pending; pending = null; return action; }

export function watchAccountLinks() {
  window.addEventListener('hashchange', event => {
    if (!consumeAccountLink()) return;
    event.stopImmediatePropagation();
    window.dispatchEvent(new Event('formlab-account-link'));
  });
}
