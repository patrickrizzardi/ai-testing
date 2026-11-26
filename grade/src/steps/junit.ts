import type { TestsResult } from "../types.ts";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function attributesOf(tagBody: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tagBody.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
    attributes[match[1] as string] = decodeEntities(match[2] as string);
  }
  return attributes;
}

/**
 * Counts testcases in a JUnit report, naming each as
 * `suite > nested suite > test`. A testcase with a <failure> or <error> failed;
 * a skipped or todo testcase counts as failed too, because a test that did not
 * run proves nothing. The top-level file suite is left out of names
 * (`prefix` carries the file instead). O(n) time and memory in report size.
 */
export function parseJunit(xml: string, prefix: string): TestsResult {
  const result: TestsResult = { passed: 0, failed: 0, total: 0, failures: [] };
  const suiteStack: string[] = [];
  let openCase: { name: string; problem?: string } | undefined;

  const closeCase = (): void => {
    if (!openCase) return;
    result.total += 1;
    if (openCase.problem) {
      result.failed += 1;
      result.failures.push(openCase.problem === "failure" ? openCase.name : `${openCase.name} (${openCase.problem})`);
    } else {
      result.passed += 1;
    }
    openCase = undefined;
  };

  for (const match of xml.matchAll(/<(\/?)([A-Za-z]+)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, body, selfClosing] = match as unknown as [string, string, string, string, string];
    if (tag === "testsuite") {
      if (closing) suiteStack.pop();
      else if (selfClosing !== "/") suiteStack.push(attributesOf(body).name ?? "");
    } else if (tag === "testcase") {
      if (closing) {
        closeCase();
      } else {
        const names = [prefix, ...suiteStack.slice(1).filter((name) => name !== ""), attributesOf(body).name ?? ""];
        openCase = { name: names.join(" > ") };
        if (selfClosing === "/") closeCase();
      }
    } else if (!closing && openCase && (tag === "failure" || tag === "error")) {
      openCase.problem = "failure";
    } else if (!closing && openCase && tag === "skipped") {
      openCase.problem = "skipped";
    }
  }
  return result;
}
