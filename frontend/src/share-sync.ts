import { encodeStudy, type SharedStudy } from './share-state';

/** Batches edits without retaining stale snapshots or adding browser history entries. */
export class ShareSync {
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private read: () => SharedStudy, private write: (hash: string) => void,
    private onError: (error: unknown) => void) {}

  schedule() {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.flush(); } catch (error) { this.onError(error); }
    }, 400);
  }

  flush(): string {
    this.cancel();
    const hash = encodeStudy(this.read());
    this.write(hash);
    return hash;
  }

  cancel() { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
}
