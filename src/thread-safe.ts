import EventEmitter from 'events';

type LockQueueItem = { shared: boolean; grant(): void };

/**
 * Locking mechasnism that supports exclusive or shared locking.
 * Copied & modified from AceBase repository https://github.com/appy-one/acebase/blob/master/src/ts/thread-safe.ts
 */
export class ThreadSafeLock extends EventEmitter {
  readonly achieved: Date;

  private shares = 0;

  private queue = [] as LockQueueItem[];

  private _shared: boolean;

  public get shared() {
    return this._shared;
  }

  constructor(
    public readonly target: any,
    shared: boolean,
  ) {
    super();
    this._shared = shared;
    this.achieved = new Date();
  }

  release() {
    if (this.shared && this.shares > 0) {
      this.shares--;
    } else if (this.queue.length > 0) {
      const next = this.queue.shift() as LockQueueItem;
      this._shared = next.shared;
      next.grant();
      if (next.shared) {
        // Also grant other pending shared requests
        while (this.queue.length > 0 && this.queue[0]!.shared) {
          (this.queue.shift() as LockQueueItem).grant();
        }
      }
    } else {
      // No more shares, no queue: this lock can be now be released entirely
      this.emit('released');
    }
  }

  async request(shared: boolean): Promise<void> {
    if (this.shared && shared) {
      // Grant!
      this.shares++;
    } else {
      // Add to queue, wait until granted
      const promise = new Promise<void>((resolve) => {
        this.queue.push({ shared, grant: resolve });
      });
      await promise;
    }
  }
}

const currentLocks = new Map<any, ThreadSafeLock>();

/**
 *
 * @param target Target to lock
 * @param options Locking options
 * @returns returns a lock
 */
export async function acquireLock(target: any, shared = false): Promise<ThreadSafeLock> {
  if (!currentLocks.has(target)) {
    // New lock
    const newLock = new ThreadSafeLock(target, shared);
    currentLocks.set(target, newLock);
    newLock.once('released', () => {
      currentLocks.delete(target);
    });
    return newLock;
  }

  // Existing lock
  const existingLock = currentLocks.get(target) as ThreadSafeLock;
  await existingLock.request(shared);
  return existingLock;
}
