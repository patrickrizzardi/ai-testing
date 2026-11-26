import type { Finding, GradeReport } from "./types.ts";

function formatFinding(finding: Finding): string {
  return `    ${finding.file}:${finding.line}  ${finding.message}`;
}

function status(pass: boolean): string {
  return pass ? "PASS" : "FAIL";
}

/** The human summary: one line per step, details indented beneath failures. */
export function formatHuman(report: GradeReport): string {
  const lines = [`grade ${report.task}  ${report.solutionDir}`];
  lines.push(`layout     ${status(report.layout.pass)}`);
  lines.push(...report.layout.findings.map(formatFinding));
  lines.push(`typecheck  ${status(report.typecheck.pass)}`);
  lines.push(...report.typecheck.errors.map((error) => `    ${error.split("\n").join("\n    ")}`));
  for (const gate of report.gates) {
    lines.push(`gate ${gate.id}  ${status(gate.pass)}`);
    lines.push(...gate.findings.map(formatFinding));
  }
  const { tests } = report;
  lines.push(`tests      ${status(tests.failed === 0 && tests.total > 0)}  ${tests.passed}/${tests.total} passed`);
  lines.push(...tests.failures.map((name) => `    failed: ${name}`));
  lines.push(`rightFirstTime: ${report.rightFirstTime ? "yes" : "no"}`);
  return lines.join("\n");
}

export function formatJson(report: GradeReport): string {
  return JSON.stringify(report, null, 2);
}
