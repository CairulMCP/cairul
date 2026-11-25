import { SaxesParser } from 'saxes';
import { check, count, error, readProjectFile, text, verdict, z } from './checks.mjs';

function counters(values) {
  return z.strictObject({ passed: count, failed: count, skipped: count }).parse(values);
}

function xml(source, visit) {
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => {
    throw new Error('Report must not contain a DOCTYPE.');
  });
  parser.on('opentag', (tag) => {
    const attributes = Object.fromEntries(Object.values(tag.attributes).map(({ local, value }) => [local, value]));
    visit.open(tag.local, attributes);
  });
  parser.on('closetag', (tag) => visit.close?.(tag.local));
  parser.write(source).close();
}

export function junit(source, failureName) {
  const result = { passed: 0, failed: 0, skipped: 0 };
  let root;
  let test;
  let name;
  let suiteFailure = false;
  xml(source, {
    open(tag, attributes) {
      root ??= tag;
      if (tag === 'testsuite' || tag === 'testsuites') {
        suiteFailure ||= Number(attributes.failures) > 0 || Number(attributes.errors) > 0;
      }
      if (tag === 'testcase') {
        const suppressed = attributes.status === 'notrun' || ['suppressed', 'skipped'].includes(attributes.result);
        test = suppressed ? 'skipped' : 'passed';
        name = [attributes.classname, attributes.name].filter(Boolean).join(' / ');
      }
      if (!test) return;
      if (tag === 'failure' || tag === 'error') test = 'failed';
      if (tag === 'skipped' && test !== 'failed') test = 'skipped';
    },
    close(tag) {
      if (tag !== 'testcase') return;
      result[test]++;
      if (test === 'failed' && name) failureName?.(name);
      test = undefined;
    },
  });
  if (!['testsuite', 'testsuites'].includes(root)) throw new Error('Expected a JUnit XML report.');
  if (suiteFailure && result.failed === 0) result.failed = 1;
  return result;
}

const trxCounters = z.object({
  total: z.coerce.number().int().nonnegative(),
  executed: z.coerce.number().int().nonnegative(),
  passed: z.coerce.number().int().nonnegative(),
});

export function trx(source) {
  let root;
  let results;
  xml(source, {
    open(tag, attributes) {
      root ??= tag;
      if (tag === 'Counters') results = trxCounters.parse(attributes);
    },
  });
  if (root !== 'TestRun' || !results) throw new Error('Expected TRX test run counters.');
  return counters({
    passed: results.passed,
    failed: results.executed - results.passed,
    skipped: results.total - results.executed,
  });
}

const nativeCount = z.string().regex(/^\d+$/).transform(Number).pipe(count);

export function nunit(source) {
  let root;
  let summary;
  xml(source, {
    open(tag, attributes) {
      if (root) return;
      root = tag;
      if (tag === 'test-run') {
        summary = z
          .object({
            total: nativeCount,
            passed: nativeCount,
            failed: nativeCount,
            skipped: nativeCount,
            inconclusive: nativeCount,
            result: z.enum(['Passed', 'Failed', 'Inconclusive', 'Skipped']),
          })
          .parse(attributes);
      }
    },
  });
  if (!summary || summary.total !== summary.passed + summary.failed + summary.skipped + summary.inconclusive) {
    throw new Error('Expected consistent NUnit test-run counts.');
  }
  return counters({
    passed: summary.passed,
    failed: Math.max(summary.failed + summary.inconclusive, summary.result === 'Failed' ? 1 : 0),
    skipped: summary.skipped,
  });
}

export function xunit(source) {
  let root;
  let assemblies = 0;
  const results = { passed: 0, failed: 0, skipped: 0 };
  xml(source, {
    open(tag, attributes) {
      root ??= tag;
      if (tag !== 'assembly') return;
      assemblies++;
      const row = z
        .object({
          total: nativeCount,
          passed: nativeCount,
          failed: nativeCount,
          skipped: nativeCount,
          errors: nativeCount,
        })
        .parse(attributes);
      const notRun = attributes['not-run'] === undefined ? 0 : nativeCount.parse(attributes['not-run']);
      if (row.total !== row.passed + row.failed + row.skipped + notRun)
        throw new Error('xUnit assembly result counts differ.');
      results.passed += row.passed;
      results.failed += row.failed + row.errors;
      results.skipped += row.skipped + notRun;
    },
  });
  if (root !== 'assemblies' || assemblies === 0) throw new Error('Expected xUnit assembly results.');
  return counters(results);
}

const jestSchema = z.object({
  success: z.boolean(),
  numPassedTests: count,
  numFailedTests: count,
  numPendingTests: count,
  numTodoTests: count.default(0),
  numFailedTestSuites: count,
});

export function jest(source) {
  const result = jestSchema.parse(JSON.parse(source));
  return {
    passed: result.numPassedTests,
    failed: Math.max(result.numFailedTests, result.numFailedTestSuites, result.success ? 0 : 1),
    skipped: result.numPendingTests + result.numTodoTests,
  };
}

const playwrightSchema = z.object({
  stats: z.object({ expected: count, unexpected: count, flaky: count, skipped: count }),
  errors: z.array(z.unknown()).default([]),
});

export function playwright(source) {
  const { stats, errors } = playwrightSchema.parse(JSON.parse(source));
  return { passed: stats.expected, failed: stats.unexpected + stats.flaky + errors.length, skipped: stats.skipped };
}

const goEvent = z.object({ Action: text, Package: text.optional(), Test: text.optional() });

export function goTest(source, minimumDepth = 1) {
  const result = { passed: 0, failed: 0, skipped: 0 };
  const packages = new Set();
  const packageFailures = new Set();
  const failingTests = new Set();
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const { Action, Package, Test } = goEvent.parse(JSON.parse(line));
    if (Action === 'build-fail') result.failed++;
    if (!Test) {
      if (Action === 'start') packages.add(Package);
      if (['pass', 'fail', 'skip'].includes(Action)) packages.delete(Package);
      if (Action === 'fail') packageFailures.add(Package);
      continue;
    }
    if (Test.split('/').length >= minimumDepth) {
      if (Action === 'pass') result.passed++;
      if (Action === 'skip') result.skipped++;
    }
    if (Action === 'fail') {
      failingTests.add(Package);
      result.failed++;
    }
  }
  if (packages.size) throw new Error('Go test report is incomplete.');
  result.failed += [...packageFailures].filter((name) => !failingTests.has(name)).length;
  return result;
}

const tapLine = /^((?:not )?ok)\b(.*)$/i;
const suites = /^1\.\.(\d+)(?:\s|$)/m;

export function tap(source) {
  const plan = suites.exec(source);
  if (!plan || /^Bail out!/im.test(source)) throw new Error('Expected a completed TAP report.');
  const result = { passed: 0, failed: 0, skipped: 0 };
  for (const line of source.split(/\r?\n/)) {
    const test = tapLine.exec(line);
    if (!test) continue;
    if (/\s#\s*(skip|todo)\b/i.test(test[2])) result.skipped++;
    else if (test[1].toLowerCase() === 'ok') result.passed++;
    else result.failed++;
  }
  if (result.passed + result.failed + result.skipped !== Number(plan[1]))
    throw new Error('TAP plan and result counts differ.');
  return result;
}

export function testPlugin(kind, formats, defaultFormat = Object.keys(formats)[0]) {
  const schema = z.strictObject({
    reports: z.union([text, z.array(text).min(1)]),
    format: z.enum(Object.keys(formats)).default(defaultFormat),
    minTests: count.default(1),
    maxSkipped: count.optional(),
  });
  return () => ({
    checkKinds: {
      [kind]: check(schema, async ({ reports, format, minTests, maxSkipped }, { projectDir, signal }) => {
        const total = { passed: 0, failed: 0, skipped: 0 };
        for (const file of new Set(Array.isArray(reports) ? reports : [reports])) {
          try {
            const report = counters(formats[format](await readProjectFile(projectDir, file, signal)));
            total.passed += report.passed;
            total.failed += report.failed;
            total.skipped += report.skipped;
          } catch (cause) {
            return cause?.code === 'ENOENT'
              ? verdict(false, 'Waiting for a test report.')
              : error('Test report is unreadable, invalid, or incomplete.');
          }
        }
        const matches =
          total.failed === 0 && total.passed >= minTests && (maxSkipped === undefined || total.skipped <= maxSkipped);
        return verdict(
          matches,
          `${total.passed} passed, ${total.failed} failed, ${total.skipped} skipped. Required: at least ${minTests} passed and zero failures${maxSkipped === undefined ? '' : `, at most ${maxSkipped} skipped`}.`
        );
      }),
    },
  });
}

export function testng(source) {
  let root;
  let result;
  xml(source, {
    open(tag, attributes) {
      if (root) return;
      root = tag;
      if (tag === 'testng-results') {
        result = {
          passed: nativeCount.parse(attributes.passed),
          failed: nativeCount.parse(attributes.failed),
          skipped: nativeCount.parse(attributes.skipped),
        };
      }
    },
  });
  if (!result) throw new Error('Expected TestNG test results.');
  return result;
}
