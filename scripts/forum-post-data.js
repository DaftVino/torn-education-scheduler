'use strict';

const { loadUserscript, loadFixture } = require('../tests/load-userscript');

const DAY = 24 * 60 * 60;
const SIX_MONTH_CHECKPOINT_DAYS = 182;

// Presets will eventually store these course sets, not their order. The
// foundation is intentionally its own route: finish it first, then choose a
// follow-on route and let the scheduler order that set for the player's goal.
const ROUTE_CODES = Object.freeze({
  foundation: ['BIO1340', 'BIO2127'],
  fighting: ['BIO1340', 'BIO2127', 'SPT3510'],
  crime: [
    'BIO1340', 'BIO2127',
    'CMT1520', 'CMT2230', 'CMT2530', 'CMT2130', 'CMT2131',
    'PSY1630', 'PSY2640', 'PSY2650', 'PSY2660', 'PSY2670', 'PSY2680',
    'PSY2132', 'PSY3690',
  ],
  trader: ['BIO1340', 'BIO2127', 'HIS3210'],
  undecided: [
    'BIO1340', 'BIO2127',
    'DEF1700', 'DEF2740', 'DEF2750', 'DEF2760',
    'HAF1103', 'HAF2107', 'HAF2106', 'HAF2109',
    'CBT1780', 'CBT2820', 'CBT2830', 'CBT2840', 'CBT2850',
  ],
});

const APPROVED_TAXONOMY = Object.freeze({
  'Unlocks & Abilities': { selections: 35, links: 36, courses: 23 },
  'Passive Stat Bonus': { selections: 4, links: 24, courses: 22 },
  'Combat Bonuses': { selections: 17, links: 18, courses: 18 },
  'Company Bonuses': { selections: 5, links: 13, courses: 13 },
  'Crime & Jail Bonuses': { selections: 6, links: 10, courses: 8 },
  'Gym Gain Bonus': { selections: 4, links: 8, courses: 5 },
  'Computing Bonuses': { selections: 3, links: 5, courses: 5 },
  'General Progression Bonuses': { selections: 3, links: 3, courses: 3 },
  'Medical Effectiveness': { selections: 2, links: 3, courses: 3 },
});

const FACT_CHECKS = Object.freeze([
  ['BIO2410', 'name', 'Anatomy'],
  ['BIO2410', 'outcome', 'Gain a 3% chance increase of achieving a critical hit'],
  ['MTH3330', 'outcome', 'Gain a 20% bonus to ammo conservation'],
  ['CBT2820', 'outcome', 'Gain a +1.00 accuracy increase with Machine Guns'],
  ['DEF2730', 'outcome', 'Gain a 2% passive bonus to defense'],
  ['BIO2380', 'name', 'Fundamentals of Neurobiology'],
  ['BIO2380', 'outcome', "Gain a 10% damage increase when hitting an opponent's throat"],
  ['BIO2400', 'outcome', "Decrease an opponent's stealthiness by 0.5"],
  ['HAF3111', 'outcome', "Gain a 25% increase in speed during an opponent's escape attempt"],
  ['DEF3770', 'name', 'Bachelor of Self Defense'],
  ['LAW2910', 'name', 'Property Law'],
  ['BIO1340', 'name', 'Introduction to Biochemistry'],
]);

function catalogueByCode(courses) {
  return new Map([...courses.values()].map((course) => [course.prefix, course]));
}

function routeQueue(codes, byCode, courses, requiredCoursesFor) {
  const queue = [];
  const planned = new Set();
  for (const code of codes) {
    const target = byCode.get(code);
    if (!target) throw new Error(`forum route names missing course ${code}`);
    for (const id of requiredCoursesFor(target.id, planned, courses)) {
      if (planned.has(id)) continue;
      queue.push(id);
      planned.add(id);
    }
  }
  return queue;
}

function categoryTotal(rawFixture, categoryName) {
  const category = rawFixture.categories.find((item) => item.name === categoryName);
  if (!category) throw new Error(`missing category ${categoryName}`);
  return {
    days: category.courses.reduce((sum, course) => sum + course.originDuration, 0) / DAY,
    cost: category.courses.reduce((sum, course) => sum + course.originCost, 0),
  };
}

function taxonomyReport(registry) {
  const categories = {};
  for (const entry of registry.entries) {
    const group = categories[entry.category] || {
      selectionSet: new Set(),
      courseSet: new Set(),
      links: 0,
    };
    group.selectionSet.add(entry.selection);
    group.courseSet.add(entry.courseId);
    group.links += 1;
    categories[entry.category] = group;
  }

  const measured = {};
  const allSelections = new Set();
  const allCourses = new Set();
  let links = 0;
  for (const [category, group] of Object.entries(categories)) {
    measured[category] = {
      selections: group.selectionSet.size,
      links: group.links,
      courses: group.courseSet.size,
    };
    // The approved sheet's total counts distinct selection labels. Four labels
    // are intentionally reused in more than one category, so the category-row
    // counts add to 79 while the overall distinct-selection count is 75.
    for (const selection of group.selectionSet) allSelections.add(selection);
    for (const id of group.courseSet) allCourses.add(id);
    links += group.links;
  }

  if (JSON.stringify(measured) !== JSON.stringify(APPROVED_TAXONOMY)) {
    throw new Error(`approved focus taxonomy drifted: ${JSON.stringify(measured)}`);
  }

  return {
    health: {
      stale: registry.stale,
      unmapped: registry.unmapped,
      entries: registry.entries.length,
    },
    categories: measured,
    totals: {
      selections: allSelections.size,
      links,
      courses: allCourses.size,
    },
  };
}

function factCheckReport(byCode) {
  const grouped = new Map();
  for (const [code, field, expected] of FACT_CHECKS) {
    const check = grouped.get(code) || { code, expectations: [], ok: true };
    const course = byCode.get(code);
    const actual = field === 'outcome'
      ? course && course.learningOutcomes.includes(expected) ? expected : course && course.learningOutcomes.join(' | ')
      : course && course[field];
    const ok = actual === expected;
    check.expectations.push({ field, expected, actual, ok });
    check.ok = check.ok && ok;
    grouped.set(code, check);
  }
  return [...grouped.values()];
}

function buildForumPostReport() {
  const rawFixture = loadFixture();
  const { exports: scheduler } = loadUserscript();
  const data = scheduler.parsePayload(rawFixture);
  const byCode = catalogueByCode(data.courses);
  const routes = {};

  for (const [key, codes] of Object.entries(ROUTE_CODES)) {
    const courseIds = routeQueue(codes, byCode, data.courses, scheduler.requiredCoursesFor);
    const courses = courseIds.map((id) => data.courses.get(id));
    const days = courses.reduce((sum, course) => sum + course.baseDuration, 0) / DAY;
    const cost = courses.reduce((sum, course) => sum + course.baseCost, 0);
    const problems = Array.from(
      scheduler.validateQueue(courseIds, new Set(), data.courses),
      (problem) => ({ courseId: problem.courseId, missing: Array.from(problem.missing) }),
    );
    routes[key] = {
      codes: courses.map((course) => course.prefix),
      courseIds,
      days,
      cost,
      remainingAt182: Math.max(0, days - SIX_MONTH_CHECKPOINT_DAYS),
      problems,
    };
  }

  const factChecks = factCheckReport(byCode);
  const failed = factChecks.filter((check) => !check.ok);
  if (failed.length) throw new Error(`payload fact checks failed: ${failed.map((c) => c.code).join(', ')}`);

  return {
    rawFixture,
    catalogue: { categories: rawFixture.categories.length, courses: data.courses.size },
    routes,
    taxonomy: taxonomyReport(scheduler.focusRegistry(data.courses)),
    factChecks,
    categories: {
      Business: categoryTotal(rawFixture, 'Business'),
      Law: categoryTotal(rawFixture, 'Law'),
    },
    reduction: {
      ratio: data.reduction.ratio,
      constant: data.reduction.constant,
    },
  };
}

function catalogueSnapshot(payload) {
  if (!payload || payload.success !== true || !Array.isArray(payload.categories)) {
    throw new Error('raw capture is not a recognised educationInitData payload');
  }
  return payload.categories.map((category) => ({
    id: category.id,
    name: category.name,
    courses: category.courses.map((course) => ({
      id: course.id,
      prefix: course.prefix,
      name: course.name,
      description: course.description,
      parentId: course.parentId,
      tier: course.tier,
      originDuration: course.originDuration,
      originCost: course.originCost,
      learningOutcomes: course.learningOutcomes,
      workingStatsGain: course.workingStatsGain,
    })),
  }));
}

function compareRawCatalogue(raw, reference) {
  const actual = catalogueSnapshot(raw);
  const expected = catalogueSnapshot(reference);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('fresh educationInitData catalogue differs from the tracked fixture');
  }
  return {
    categories: actual.length,
    courses: actual.reduce((sum, category) => sum + category.courses.length, 0),
  };
}

function money(value) {
  return `$${value.toLocaleString('en-US')}`;
}

function verifyForumPostDraft(html, report) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('forum post draft is empty');
  const required = [
    '<span style="font-size: 18px;"><strong>Torn Education Scheduler: a practical beginner\'s guide &amp; script companion</strong></span>',
    '<a href="https://greasyfork.org/en/scripts/590070-torn-education-scheduler">Greasy Fork</a>',
    'This guide is designed to be followed with <a href="https://greasyfork.org/en/scripts/590070-torn-education-scheduler">Torn Education Scheduler</a>',
    'When this guide says to load a route, add its course codes to that planner.',
    'When it mentions Focus, that means choosing the benefit you want the scheduler to prioritize.',
    'The scheduler also puts these routes directly in its course picker as <strong>Guide presets</strong>: <strong>0-Start Here, 1-Fighting, 2-Crime, 3-Trader / collector, and 4-Undecided</strong>.',
    'Presets 1–4 already include the Start Here foundation',
    'In the scheduler, select <strong>0-Start Here</strong> and press <strong>add</strong>.',
    'Scheduler preset: <strong>1-Fighting</strong>.',
    'Scheduler preset: <strong>2-Crime</strong>.',
    'Scheduler preset: <strong>3-Trader / collector</strong>.',
    'Scheduler preset: <strong>4-Undecided</strong>.',
    'please share it with the newer players and new friends you meet',
    'please open the Feedback tab on the <a href="https://greasyfork.org/en/scripts/590070-torn-education-scheduler">Greasy Fork page</a>',
    'Bug reports, feature requests, and ideas for improving either the guide or the script are all welcome.',
    'Ordering changes when you receive each benefit; it does not change the total finish time.',
    'heuristic',
    `Foundation</td><td>${report.routes.foundation.days} days</td><td>${money(report.routes.foundation.cost)}</td><td>Complete`,
    `Fighting</td><td>${report.routes.fighting.days} days</td><td>${money(report.routes.fighting.cost)}</td><td>${report.routes.fighting.remainingAt182} days left`,
    `Crime</td><td>${report.routes.crime.days} days</td><td>${money(report.routes.crime.cost)}</td><td>${report.routes.crime.remainingAt182} days left`,
    `Trader / collector</td><td>${report.routes.trader.days} days</td><td>${money(report.routes.trader.cost)}</td><td>${report.routes.trader.remainingAt182} days left`,
    `Undecided sampler</td><td>${report.routes.undecided.days} days</td><td>${money(report.routes.undecided.cost)}</td><td>${report.routes.undecided.remainingAt182} days left`,
    `Business is ${report.categories.Business.days} days and ${money(report.categories.Business.cost)}`,
    `Law is ${report.categories.Law.days} days and ${money(report.categories.Law.cost)}`,
  ];
  for (const [category, counts] of Object.entries(report.taxonomy.categories)) {
    const escapedCategory = category.replace(/&/g, '&amp;');
    required.push(`${escapedCategory}</td><td>${counts.selections}</td><td>${counts.links}</td><td>${counts.courses}`);
  }
  for (const text of required) {
    if (!html.includes(text)) throw new Error(`forum draft is missing verified text: ${text}`);
  }

  for (const tag of ['p', 'strong', 'em', 'span', 'a', 'ul', 'ol', 'li', 'table', 'tr', 'th', 'td']) {
    const openings = (html.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi')) || []).length;
    const closings = (html.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
    if (openings !== closings) {
      throw new Error(`forum draft has unbalanced <${tag}> tags: ${openings} open / ${closings} close`);
    }
  }

  const forbidden = [
    [/\bguide\s+\d+\b/i, 'numbered guide reference'],
    [/\b(?:old|other|existing|community)\s+(?:guide|article|post)s?\b/i, 'reference to another article'],
    [/https:\/\/www\.torn\.com\/forums[^\s)]*/i, 'direct Torn forum article link'],
    [/\bscore[sd]?\s+(?:of\s+)?\d+(?:\.\d+)?\b/i, 'absolute ranking score'],
    [/^#{1,6}\s/m, 'Markdown heading'],
    [/^\|.*\|\s*$/m, 'Markdown table row'],
    [/\[[^\]\n]+\]\(https?:\/\/[^)]+\)/i, 'Markdown link'],
    [/\[(?:\/?(?:b|i|size|url|list|table|tr|th|td)|\*)[^\]]*\]/i, 'BBCode tag'],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(html)) throw new Error(`forum draft contains a forbidden ${label}`);
  }
  return true;
}

module.exports = {
  ROUTE_CODES,
  APPROVED_TAXONOMY,
  buildForumPostReport,
  compareRawCatalogue,
  verifyForumPostDraft,
};
