// Per-note save queue. Plain JS with no browser dependencies so it can be unit
// tested in Node (see tests/saver.test.js).
//
// Rules:
//  - markChanged() is called on every edit and dispatches a storage write right
//    away when none is in flight for this note. If one is in flight, the edit is
//    picked up by the next write, which is dispatched the moment the current
//    one settles. Each write stores a fresh snapshot taken at dispatch time, so
//    every edit is either in the write that is running or in the very next one.
//  - At most one queued write per note is in flight, so writes complete in
//    order: an older snapshot can never land after a newer one.
//  - flushNow() (page hidden / unloading / navigating) additionally dispatches
//    the newest snapshot immediately even if a write is in flight, so it reaches
//    the browser process before the page can be torn down. The normal queue then
//    writes the newest snapshot once more after the in-flight write settles, so
//    the final stored value is the newest one even if storage reordered them.
//  - Status is 'saving' | 'saved' | 'failed'. 'saved' is reported only after a
//    write containing the latest revision has succeeded and nothing newer is
//    waiting.
(function (root) {
  'use strict';

  class NoteSaver {
    /**
     * @param {object} opts
     * @param {() => object} opts.snapshot  returns a copy of the current note
     * @param {(note: object) => Promise} opts.write
     * @param {() => Promise} opts.remove
     * @param {(status: string, err?: Error) => void} [opts.onStatus]
     * @param {(err: Error) => boolean} [opts.isFatal]  true = stop retrying
     * @param {number} [opts.retryDelay]
     */
    constructor(opts) {
      this.snapshot = opts.snapshot;
      this.writeFn = opts.write;
      this.removeFn = opts.remove;
      this.onStatus = opts.onStatus || (() => {});
      this.isFatal = opts.isFatal || (() => false);
      this.retryDelay = opts.retryDelay == null ? 3000 : opts.retryDelay;
      // Wrapped: browsers throw "Illegal invocation" if setTimeout is called as a method.
      this.setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
      this.clearTimer = opts.clearTimer || ((id) => clearTimeout(id));

      this.rev = 0; // bumped on every edit
      this.savedRev = 0; // newest revision known to be in storage
      this.inFlight = null; // promise of the queued write currently running
      this.inFlightRev = 0;
      this.outOfBand = new Set(); // early copies dispatched by flushNow()
      this.retryTimer = null;
      this.status = 'saved';
      this.deleted = false;
      this.stopped = false; // fatal error, e.g. extension context invalidated
    }

    /** True when storage holds the latest revision and nothing is running. */
    get idle() {
      return !this.inFlight && !this.outOfBand.size && this.savedRev === this.rev;
    }

    markChanged() {
      if (this.deleted) return;
      this.rev++;
      this.setStatus('saving');
      this.pump();
    }

    /** Push the newest state to storage as early as possible. */
    flushNow() {
      if (this.deleted || this.stopped || this.savedRev === this.rev) return;
      this.clearRetry();
      if (!this.inFlight) {
        this.pump();
        return;
      }
      if (this.inFlightRev === this.rev) return; // newest is already on its way
      // Out-of-band early copy; the queue re-writes the newest after it settles.
      const p = this.dispatch(this.snapshot()).catch(() => {});
      this.outOfBand.add(p);
      p.then(() => this.outOfBand.delete(p));
    }

    /** Waits until every write has settled (used by tests and before deletion). */
    async settle() {
      while (this.inFlight || this.outOfBand.size) {
        await Promise.all([this.inFlight, ...this.outOfBand]);
      }
    }

    /**
     * Deletes the note after every write in flight, so a late write can never
     * recreate it. Resolves when removed; rejects (and re-enables saving) on error.
     */
    remove() {
      this.deleted = true;
      this.clearRetry();
      return this.settle()
        .then(() => this.removeFn())
        .catch((err) => {
          this.deleted = false;
          throw err;
        });
    }

    /** Stops all saving without deleting (the note was deleted in another tab). */
    discard() {
      this.deleted = true;
      this.clearRetry();
    }

    /** After a failed delete: make sure the note is stored again. */
    restore() {
      this.deleted = false;
      this.markChanged();
    }

    /** Called when another tab's newer copy replaced the note in memory. */
    acceptRemote() {
      if (this.idle) this.setStatus('saved');
    }

    // -- internals

    pump() {
      if (this.inFlight || this.deleted || this.stopped) return;
      if (this.savedRev === this.rev) {
        this.setStatus('saved');
        return;
      }
      this.clearRetry();
      const rev = this.rev;
      this.inFlightRev = rev;
      let failure = null;
      const run = this.dispatch(this.snapshot()).then(
        () => {
          if (rev > this.savedRev) this.savedRev = rev;
        },
        (err) => {
          failure = err || new Error('Unknown storage error');
        }
      );
      this.inFlight = run.then(() => {
        this.inFlight = null;
        this.inFlightRev = 0;
        if (this.deleted) return;
        if (failure) {
          this.onFailure(failure);
          // A newer edit made during the failed write gets one immediate try.
          if (!this.stopped && this.rev > rev) this.pump();
          return;
        }
        this.pump(); // writes newer edits, or reports 'saved'
      });
    }

    dispatch(note) {
      try {
        // Called synchronously so the request leaves the page immediately.
        return Promise.resolve(this.writeFn(note));
      } catch (err) {
        return Promise.reject(err);
      }
    }

    onFailure(err) {
      this.setStatus('failed', err);
      if (this.isFatal(err)) {
        this.stopped = true;
        return;
      }
      this.clearRetry();
      this.retryTimer = this.setTimer(() => {
        this.retryTimer = null;
        this.pump();
      }, this.retryDelay);
    }

    clearRetry() {
      if (this.retryTimer != null) {
        this.clearTimer(this.retryTimer);
        this.retryTimer = null;
      }
    }

    setStatus(status, err) {
      if (status === this.status && status !== 'failed') return;
      this.status = status;
      this.onStatus(status, err);
    }
  }

  root.TabNotesSaver = NoteSaver;
  if (typeof module !== 'undefined' && module.exports) module.exports = NoteSaver;
})(typeof globalThis !== 'undefined' ? globalThis : this);
