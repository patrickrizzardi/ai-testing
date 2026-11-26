import type { Heap, RootStack } from "./heap";

/**
 * One thread of Ripple execution: the main program, or one member of a concurrent run.
 * Holds what is private to the thread: its root stack, its printed output and its call depth.
 */
export type Strand = {
  readonly roots: RootStack;
  readonly output: string[];
  /** Number of user-function calls active in the chain of callers of this strand (spec 6.3). */
  depth: number;
};

export function openStrand(heap: Heap, depth: number): Strand {
  return { roots: heap.openRootStack(), output: [], depth };
}

export function closeStrand(heap: Heap, strand: Strand): void {
  heap.closeRootStack(strand.roots);
}
