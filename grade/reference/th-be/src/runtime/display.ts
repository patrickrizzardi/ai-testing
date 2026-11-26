import type { RuntimeValue } from "./values";

const STRING_ESCAPES: Readonly<Record<string, string>> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r" };

function quoted(text: string): string {
  return `"${text.replace(/[\\"\n\t\r]/g, (character) => STRING_ESCAPES[character] ?? character)}"`;
}

/** `display(v)` of spec 5.1; a string is shown bare only at `topLevel`. O(size of the value). */
export function displayValue(value: RuntimeValue, topLevel: boolean): string {
  if (typeof value === "string") return topLevel ? value : quoted(value);
  if (value === null) return "nil";
  if (typeof value !== "object") return String(value);
  switch (value.kind) {
    case "array":
      return `[${value.items.map((element) => displayValue(element, false)).join(", ")}]`;
    case "record":
      return `{${[...value.fields].map(([name, field]) => `${name}: ${displayValue(field, false)}`).join(", ")}}`;
    case "closure":
      return `<fn ${value.declaration.name}>`;
    case "builtin":
      return `<builtin ${value.name}>`;
  }
}
