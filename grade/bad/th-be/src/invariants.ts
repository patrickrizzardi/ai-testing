/**
 * Lookups that cannot miss unless the interpreter itself is wrong: a miss is a bug in the
 * interpreter, thrown as an `Error`, and never a Ripple error. O(1).
 */
export function requireEntry<Key, Found>(table: ReadonlyMap<Key, Found>, key: Key, what: string): Found {
  const found = table.get(key);
  if (found === undefined) throw new Error(`the interpreter has no ${what}`);
  return found;
}

/** The element of `items` at `index`, which a bounds check or a construction rule guarantees exists. O(1). */
export function requireElement<Item>(items: readonly Item[], index: number, what: string): Item {
  const item = items[index];
  if (item === undefined) throw new Error(`the interpreter has no ${what} at index ${index}`);
  return item;
}
