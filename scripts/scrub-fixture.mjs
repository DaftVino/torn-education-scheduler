#!/usr/bin/env node
// Turns a raw educationInitData capture into a committable fixture.
//
// The raw capture is personal data: `status` encodes which courses the account
// has completed, and `activeCourse.completedAt` is a real timestamp on a real
// account. The course catalogue itself is identical for every player and is
// preserved byte-for-byte.
//
// Raw captures live in tests/fixtures/raw/, which is gitignored and must never
// be committed. Only the output of this script is.
//
//   node scripts/scrub-fixture.mjs
//   node scripts/scrub-fixture.mjs <raw.json> <out.json>

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const RAW = process.argv[2] ?? 'tests/fixtures/raw/educationInitData.json';
const OUT = process.argv[3] ?? 'tests/fixtures/education-init-data.json';

// A synthetic progress state, chosen to exercise the scheduler rather than to
// describe anybody. Sports Science is complete through its bachelor, Biology is
// part-done, and one course is in progress — so the fixture covers all four
// status values and both the parentId chain and the tier-3 gate.
const COMPLETED_CATEGORIES = ['Sports Science'];
const COMPLETED_PREFIXES = ['BIO1340', 'BIO2350', 'BIO2360', 'CMT1520', 'HIS1140'];
const IN_PROGRESS_PREFIX = 'BIO2370';

// 2026-01-01T00:00:00Z. Fixed so tests compare against a constant, and so the
// fixture carries no real account's timing.
const IN_PROGRESS_COMPLETES_AT = 1767225600;

if (!existsSync(RAW)) {
  console.error(`no raw capture at ${RAW}`);
  console.error('capture one from the education page console, then re-run:');
  console.error("  fetch('/page.php?sid=educationInitData').then(r=>r.json()).then(d=>{");
  console.error("    const a=document.createElement('a');");
  console.error("    a.href=URL.createObjectURL(new Blob([JSON.stringify(d,null,1)]));");
  console.error("    a.download='educationInitData.json'; a.click()})");
  process.exit(1);
}

const data = JSON.parse(readFileSync(RAW, 'utf8'));

if (data.success !== true || !Array.isArray(data.categories)) {
  console.error('raw capture is not a recognised educationInitData payload');
  process.exit(1);
}

const all = data.categories.flatMap((c) =>
  c.courses.map((course) => ({ course, category: c })),
);
const byId = new Map(all.map(({ course }) => [course.id, course]));

const completed = new Set();
for (const { course, category } of all) {
  if (COMPLETED_CATEGORIES.includes(category.name)) completed.add(course.id);
  if (COMPLETED_PREFIXES.includes(course.prefix)) completed.add(course.id);
}

const inProgress = all.find(({ course }) => course.prefix === IN_PROGRESS_PREFIX);
if (!inProgress) {
  console.error(`${IN_PROGRESS_PREFIX} not present in the capture`);
  process.exit(1);
}
completed.delete(inProgress.course.id);

// Torn's own gating rules, re-derived so the fixture is internally consistent:
// a course needs its parent complete, and a tier-3 bachelor needs every tier-2
// course in its category. Bachelors carry parentId: null, so the tier-3 rule is
// the one piece of prerequisite knowledge not present in the payload.
function statusOf(course, category) {
  if (course.id === inProgress.course.id) return 'inProgress';
  if (completed.has(course.id)) return 'completed';

  if (course.tier === 3) {
    const tier2 = category.courses.filter((c) => c.tier === 2);
    return tier2.every((c) => completed.has(c.id)) ? 'available' : 'notMeetRequirement';
  }
  if (course.parentId === null) return 'available';
  return completed.has(course.parentId) ? 'available' : 'notMeetRequirement';
}

for (const { course, category } of all) {
  course.status = statusOf(course, category);
}

data.activeCourse = {
  id: inProgress.course.id,
  category: inProgress.category.id,
  name: inProgress.course.name,
  completedAt: IN_PROGRESS_COMPLETES_AT,
};
data.completedCourse = null;

writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n');

const counts = {};
for (const { course } of all) counts[course.status] = (counts[course.status] ?? 0) + 1;
console.log(`scrubbed ${all.length} courses across ${data.categories.length} categories → ${OUT}`);
console.log(Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`).join('\n'));

// A cheap invariant worth asserting at capture time rather than discovering in
// the engine: the design assumes one account-wide reduction ratio.
const ratios = new Set(
  all
    .filter(({ course }) => course.originDuration > 0)
    .map(({ course }) => (course.actualDuration / course.originDuration).toFixed(6)),
);
console.log(`  reduction ratios present: ${[...ratios].join(', ')}`);
if (ratios.size > 1) {
  console.log('  NOTE: ratio is not constant — the single-multiplier assumption does not hold');
}
if (byId.size !== all.length) console.log('  NOTE: duplicate course ids in payload');
