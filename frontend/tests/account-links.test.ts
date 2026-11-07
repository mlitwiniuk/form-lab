import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeAccountLink, parseAccountLink, takeAccountLink, watchAccountLinks } from '../src/account-links';
const token = 'a'.repeat(64);
afterEach(() => { takeAccountLink(); vi.unstubAllGlobals(); });
describe('email action links', () => {
  it.each(['signup', 'reset', 'email'])('recognizes the %s flow without a GET mutation', purpose => {
    expect(parseAccountLink(`#account=${purpose}&token=${token}`)).toEqual({ purpose, token });
  });
  it('leaves normal study hashes and unsupported actions alone', () => {
    expect(parseAccountLink('#s=encoded-study')).toBe(null); expect(parseAccountLink('#account=admin&token=abc')).toBe(null);
  });
  it('removes bearer tokens and private-save IDs from history before rendering and hands them off once', () => {
    const replaceState = vi.fn(); vi.stubGlobal('window', { location: new URL(`https://example.test/?save=private&other=1#account=reset&token=${token}`), history: { state: null, replaceState } });
    expect(consumeAccountLink()).toBe(true);
    const clean = replaceState.mock.calls[0][2] as URL; expect(clean.hash).toBe(''); expect(clean.search).toBe('?other=1'); expect(clean.href).not.toContain(token);
    expect(takeAccountLink()).toEqual({ purpose: 'reset', token }); expect(takeAccountLink()).toBe(null);
  });
  it('intercepts action links opened in an existing page before the study loader handles the hash', () => {
    const addEventListener = vi.fn(), dispatchEvent = vi.fn(), stopImmediatePropagation = vi.fn();
    vi.stubGlobal('window', { location: new URL(`https://example.test/#account=signup&token=${token}`), history: { state: null, replaceState: vi.fn() }, addEventListener, dispatchEvent });
    watchAccountLinks(); addEventListener.mock.calls[0][1]({ stopImmediatePropagation });
    expect(stopImmediatePropagation).toHaveBeenCalled(); expect(dispatchEvent.mock.calls[0][0].type).toBe('formlab-account-link'); expect(takeAccountLink()?.purpose).toBe('signup');
  });
  it('keeps incomplete links in the confirmation flow so the UI can offer a new link', () => {
    expect(parseAccountLink('#account=reset')).toEqual({ purpose: 'reset', token: '' });
  });
});
