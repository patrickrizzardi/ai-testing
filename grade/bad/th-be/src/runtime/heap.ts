import { ArrayObject, RecordObject, type HeapValue, type RuntimeValue } from "./values";
import { UNINITIALIZED, type Scope } from "./scope";

/** Anything the collector can follow: a value, or a scope (which reaches its variables and its parent). */
type Traceable = RuntimeValue | Scope;

const MINIMUM_COLLECTION_INTERVAL = 1024;

/**
 * The values an execution strand keeps alive: active scopes and in-flight values (spec section 10).
 * Used as a stack: `mark` before holding, `popTo` after.
 */
export class RootStack {
  private items: Traceable[] = [];

  /** Holds `item`; scalars need no holding and are skipped. */
  push(item: Traceable): void {
    if (typeof item === "object" && item !== null) this.items.push(item);
  }

  mark(): number {
    return this.items.length;
  }

  popTo(mark: number): void {
    this.items.length = mark;
  }

  /** Releases the topmost holding of `item`. */
  remove(item: Traceable): void {
    const position = this.items.lastIndexOf(item);
    if (position >= 0) this.items.splice(position, 1);
  }

  clear(): void {
    this.items.length = 0;
  }

  held(): readonly Traceable[] {
    return this.items;
  }
}

/**
 * The counted heap of one `run`: creates arrays and records, and frees each one exactly once
 * when no strand's roots reach it any more. Collection is mark and sweep, started only at
 * statement boundaries (`collectIfDue`) and at the end, when every in-flight value of every
 * strand is held by a root stack.
 */
export class Heap {
  private readonly live = new Set<HeapValue>();
  private readonly rootStacks = new Set<RootStack>();
  private allocations = 0;
  private frees = 0;
  private allocationsSinceCollection = 0;
  private collectionInterval = MINIMUM_COLLECTION_INTERVAL;
  private epoch = 0;

  createArray(items: RuntimeValue[]): ArrayObject {
    return this.register(new ArrayObject(items));
  }

  createRecord(fields: Map<string, RuntimeValue>): RecordObject {
    return this.register(new RecordObject(fields));
  }

  private register<Created extends HeapValue>(created: Created): Created {
    this.live.add(created);
    this.allocations += 1;
    this.allocationsSinceCollection += 1;
    return created;
  }

  openRootStack(): RootStack {
    const stack = new RootStack();
    this.rootStacks.add(stack);
    return stack;
  }

  closeRootStack(stack: RootStack): void {
    this.rootStacks.delete(stack);
  }

  get counts(): { allocs: number; frees: number } {
    return { allocs: this.allocations, frees: this.frees };
  }

  /**
   * Collects once as many objects were created as the last collection took work (never fewer than
   * `MINIMUM_COLLECTION_INTERVAL`): amortized O(1) per creation or element added.
   */
  collectIfDue(): void {
    if (this.allocationsSinceCollection >= this.collectionInterval) this.collect();
  }

  /** Frees every live object no root stack reaches. O(live objects + references followed) time, O(references followed) memory. */
  collect(): void {
    this.epoch += 1;
    const referencesFollowed = this.markReachable();
    for (const object of this.live) {
      if (object.markEpoch === this.epoch) continue;
      this.live.delete(object);
      this.frees += 1;
    }
    this.allocationsSinceCollection = 0;
    this.collectionInterval = Math.max(MINIMUM_COLLECTION_INTERVAL, this.live.size, referencesFollowed);
  }

  /** Marks everything the root stacks reach with the current epoch, iteratively; returns how many references it followed. O(that many) time and memory. */
  private markReachable(): number {
    const pending: Traceable[] = [];
    for (const stack of this.rootStacks) {
      for (const item of stack.held()) pending.push(item);
    }
    let referencesFollowed = 0;
    for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
      referencesFollowed += 1;
      if (typeof item !== "object" || item === null) continue;
      switch (item.kind) {
        case "array":
          if (this.claim(item)) for (const element of item.items) pending.push(element);
          break;
        case "record":
          if (this.claim(item)) for (const field of item.fields.values()) pending.push(field);
          break;
        case "closure":
          pending.push(item.scope);
          break;
        case "scope":
          if (!this.claim(item)) break;
          for (const slot of item.slots) if (slot !== UNINITIALIZED) pending.push(slot);
          if (item.parent !== null) pending.push(item.parent);
          break;
        case "builtin":
          break;
      }
    }
    return referencesFollowed;
  }

  /** Marks `item` as reached in this collection; false when it already was. */
  private claim(item: { markEpoch: number }): boolean {
    if (item.markEpoch === this.epoch) return false;
    item.markEpoch = this.epoch;
    return true;
  }
}
