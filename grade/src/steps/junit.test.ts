import { expect, test } from "bun:test";
import { parseJunit } from "./junit.ts";

// High tier (parser). Bugs caught: failed or skipped tests counted as passes; nested suite names lost;
// XML entities left encoded in names.
const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" failures="1" skipped="2">
  <testsuite name="a.test.ts" file="a.test.ts" tests="5">
    <testsuite name="grp &amp; co" file="a.test.ts" line="2" tests="4">
      <testcase name="ok" classname="grp" time="0.1" />
      <testcase name="bad" classname="grp" time="0.1">
        <failure type="AssertionError" message="expected&#10;2">trace &lt;here&gt;</failure>
      </testcase>
      <testcase name="sk" classname="grp" time="0">
        <skipped />
      </testcase>
      <testcase name="td" classname="grp" time="0">
        <skipped message="TODO" />
      </testcase>
    </testsuite>
    <testcase name="top" classname="" time="0.1" />
  </testsuite>
</testsuites>`;

test("counts, names and decodes a bun JUnit report", () => {
  expect(parseJunit(report, "a.test.ts")).toEqual({
    passed: 2,
    failed: 3,
    total: 5,
    failures: ["a.test.ts > grp & co > bad", "a.test.ts > grp & co > sk (skipped)", "a.test.ts > grp & co > td (skipped)"],
  });
});

test("an empty report has no tests", () => {
  expect(parseJunit('<testsuites name="bun test" tests="0"></testsuites>', "x.test.ts")).toEqual({ passed: 0, failed: 0, total: 0, failures: [] });
});
