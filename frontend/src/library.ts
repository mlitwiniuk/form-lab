import { parseSharedStudy } from './share-state';
export type SaveKind = 'study' | 'sketchfab';
export interface SavedConfiguration {
  id: string; title: string; kind: SaveKind; settings: unknown; revision: number; updated_at: number;
}
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/${path}`, { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new ApiError(0, 'Could not connect. Check your connection and try again.'); }
  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(response.status, response.status === 401 ? 'Your session has ended. Sign in to continue.' : text.startsWith('<') ? 'Accounts are unavailable at this address.' : text.slice(0, 300) || 'The request failed. Try again.');
  }
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new ApiError(0, 'Accounts are unavailable at this address.');
  return response.json() as Promise<T>;
}
export function studyFromSave(settings: unknown) { return parseSharedStudy(settings); }
export function configurationUrl(save: SavedConfiguration) {
  return `${save.kind === 'study' ? '/' : '/sketchfab/'}?save=${encodeURIComponent(save.id)}`;
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
