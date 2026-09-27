// One TTS follow navigation at a time.
//
// A highlight mark in another section than the one on screen makes the reader
// call view.goTo(cfi), and that stays pending while foliate loads the section
// (seconds, when its images block the iframe load). Marks keep arriving in the
// meantime: after an unlock the recording is still playing, and every block the
// controller moves on to dispatches one. Followed as they came, each started a
// second goTo, or a scroll inside the section still on screen, and the first
// goTo could then resolve late and put the page back behind the voice. Two
// visible moves, or a page left on a sentence already spoken.
//
// While a navigation is pending, a newer target is only recorded. Once it
// settles, the latest target (if it is not the one just reached) is followed
// once: normally a scroll inside the section just loaded, or another coalesced
// goTo if it is in yet another section. No two navigations are ever in flight,
// so no resolution can land after a newer target's.

export interface TTSFollowTarget {
  cfi: string;
  preview?: boolean;
}

export class TTSFollowNavigation<T extends TTSFollowTarget = TTSFollowTarget> {
  #follow: (target: T) => Promise<unknown> | void;
  #pending = false;
  #latest: T | null = null;

  // `follow` moves the view to a target. It returns the navigation's promise
  // when it started one that completes later (a cross-section goTo), and
  // nothing when it moved synchronously or not at all.
  constructor(follow: (target: T) => Promise<unknown> | void) {
    this.#follow = follow;
  }

  get pending(): boolean {
    return this.#pending;
  }

  push(target: T): void {
    if (this.#pending) {
      this.#latest = target;
      return;
    }
    const navigation = this.#follow(target);
    if (!navigation) return;
    this.#pending = true;
    void Promise.resolve(navigation)
      .catch(() => undefined)
      .then(() => {
        this.#pending = false;
        const next = this.#latest;
        this.#latest = null;
        if (next && next.cfi !== target.cfi) this.push(next);
      });
  }
}
