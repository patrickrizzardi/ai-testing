export const BUILTIN_NAMES = ["print", "len", "push", "keys", "sleep", "fetch"] as const;

export type BuiltinName = (typeof BUILTIN_NAMES)[number];

export function isBuiltinName(name: string): name is BuiltinName {
  return (BUILTIN_NAMES as readonly string[]).includes(name);
}

/** Builtins that wait on the clock (spec section 8). */
export const ASYNCHRONOUS_BUILTINS: ReadonlySet<string> = new Set<BuiltinName>(["sleep", "fetch"]);

export const MUTATING_BUILTIN: BuiltinName = "push";

export const MAXIMUM_CALL_DEPTH = 200;
