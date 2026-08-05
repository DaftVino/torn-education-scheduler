// ==UserScript==
// @name         Torn Education Scheduler
// @namespace    https://github.com/DaftVino/torn-education-scheduler
// @version      0.2.0
// @description  Turns Torn's education page into a live planner: queue courses, get the exact finish date.
// @author       DaftVino
// @match        https://www.torn.com/page.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

// @match cannot express a query string, so it is deliberately broader than the
// target page and isEducationPage() below does the real scoping. Widening
// @match or @grant beyond this needs a stated reason in the PR description.

(function () {
  'use strict';

  const SCRIPT_VERSION = '0.2.0';
  const EDU_ENDPOINT = '/page.php?sid=educationInitData';
  const STORAGE_KEY = 'tes:plan';
  const SETTINGS_KEY = 'tes:settings';
  // The picker's "everything I have left" entry. A string, deliberately: it
  // shares a field with course ids, and Number('__all__') is NaN rather than a
  // plausible id, so a missed guard fails visibly instead of queueing course 0.
  const ALL_COURSES_OPTION = '__all__';

  // Resolved post-launch, once the script is published. Until then every
  // consumer guards on null and renders nothing: a wrong link in a diagnostic
  // is worse than an obvious placeholder, because it looks like it works.
  const GREASY_FORK_URL = null;
  const FORUM_POST_URL = null;

  // ─── ENGINE START ───────────────────────────────────────────────
  // Pure functions only. No DOM, no network, no GM_*, no ambient clock.
  // Enforced by tests/purity.test.js, which strips comments before scanning —
  // prose here may use ordinary English words like window or location; code
  // here may not touch them.

  const VALID_STATUSES = new Set(['completed', 'inProgress', 'available', 'notMeetRequirement']);

  function PayloadError(reason, detail) {
    const err = new Error(`education payload rejected: ${reason}${detail ? ` (${detail})` : ''}`);
    err.name = 'PayloadError';
    err.reason = reason;
    return err;
  }

  function isInt(v) {
    return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v;
  }

  // Torn requires an anti-CSRF token, rfcv, as a query parameter on every XHR
  // it fires. Confirmed empirically on a live session: the token is the
  // entire 13-character value of either the rfc_v or rfc_id cookie, rfc_v
  // preferred. This function only parses a cookie string handed to it by the
  // caller — it stays pure and testable without a real cookie jar.
  function readRfcvToken(cookieString) {
    if (typeof cookieString !== 'string' || cookieString.length === 0) return null;

    const values = {};
    for (const part of cookieString.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      if (name.length === 0 || Object.prototype.hasOwnProperty.call(values, name)) continue;
      values[name] = part.slice(eq + 1).trim();
    }

    if (values.rfc_v) return values.rfc_v;
    if (values.rfc_id) return values.rfc_id;
    return null;
  }

  // Sane Unix-seconds bounds for activeCourse.completedAt:
  // 2020-01-01T00:00:00Z (1577836800) to 2100-01-01T00:00:00Z (4102444800).
  // Torn launched well after the lower bound and this script will be long
  // dead before the upper one, so any real completedAt sits comfortably
  // between them. The pair exists for one specific corruption: a backend
  // that starts sending milliseconds instead of seconds. isInt alone waves
  // that through — a millisecond timestamp is still a perfectly good
  // integer — and it would silently multiply the finish date out by a
  // factor of ~1000 (e.g. the year 57970 instead of 2026) with no error.
  // A millisecond value for "now" is on the order of 1.7e12, three orders
  // of magnitude past MAX_COMPLETED_AT, so it falls outside these bounds
  // and gets rejected here instead of shipped to the player as a real date.
  const MIN_COMPLETED_AT = 1577836800; // 2020-01-01T00:00:00Z
  const MAX_COMPLETED_AT = 4102444800; // 2100-01-01T00:00:00Z

  function normaliseCourse(raw, categoryId) {
    if (!raw || !isInt(raw.id)) throw PayloadError('bad-course', 'missing id');
    if (!isInt(raw.originDuration) || !isInt(raw.actualDuration)) {
      throw PayloadError('bad-course', `${raw.prefix || raw.id} has no usable duration`);
    }
    if (raw.parentId !== null && !isInt(raw.parentId)) {
      throw PayloadError('bad-course', `${raw.prefix || raw.id} has a non-numeric parentId`);
    }
    if (!VALID_STATUSES.has(raw.status)) {
      throw PayloadError('bad-course', `${raw.prefix || raw.id} has unknown status ${raw.status}`);
    }
    return {
      id: raw.id,
      prefix: raw.prefix,
      name: raw.name,
      tier: raw.tier,
      categoryId: categoryId,
      status: raw.status,
      baseDuration: raw.originDuration,
      duration: raw.actualDuration,
      baseCost: raw.originCost,
      cost: raw.actualCost,
      parentId: raw.parentId,
      learningOutcomes: Array.isArray(raw.learningOutcomes) ? raw.learningOutcomes : [],
      workingStatsGain: Array.isArray(raw.workingStatsGain) ? raw.workingStatsGain : [],
    };
  }

  // The design assumes one account-wide reduction. If that stops being true,
  // say so rather than picking a value — a per-course ratio would mean Torn
  // changed the mechanic, and a guess would hide it.
  function deriveReduction(courses) {
    const seen = new Set();
    for (const course of courses.values()) {
      if (course.baseDuration > 0) {
        seen.add(Number((course.duration / course.baseDuration).toFixed(6)));
      }
    }
    const ratios = [...seen].sort((a, b) => a - b);
    return {
      ratio: ratios.length === 1 ? ratios[0] : null,
      constant: ratios.length === 1,
      ratios: ratios,
    };
  }

  function parsePayload(raw) {
    if (!raw || raw.success !== true) {
      // Torn tells us exactly what went wrong (e.g. "Wrong rfcv token") — carry
      // it into the detail instead of discarding it. raw.error may be absent
      // or a non-string; only a string is safe to splice into the message
      // without rendering "[object Object]".
      const detail = raw && typeof raw.error === 'string' ? raw.error : undefined;
      throw PayloadError('not-a-payload', detail);
    }
    if (!Array.isArray(raw.categories) || raw.categories.length === 0) throw PayloadError('no-categories');

    const courses = new Map();
    const categories = [];
    const completedIds = new Set();

    for (const category of raw.categories) {
      if (!isInt(category.id) || !Array.isArray(category.courses)) {
        throw PayloadError('no-categories', `category ${category && category.name} is malformed`);
      }
      const courseIds = [];
      for (const rawCourse of category.courses) {
        const course = normaliseCourse(rawCourse, category.id);
        courses.set(course.id, course);
        courseIds.push(course.id);
        if (course.status === 'completed') completedIds.add(course.id);
      }
      categories.push({ id: category.id, name: category.name, courseIds: courseIds });
    }

    const active = raw.activeCourse;
    let activeCourse = null;
    if (active !== null && active !== undefined) {
      if (!isInt(active.id) || !isInt(active.completedAt)) {
        throw PayloadError('bad-active-course', 'id and completedAt must both be integers');
      }
      if (active.completedAt < MIN_COMPLETED_AT || active.completedAt > MAX_COMPLETED_AT) {
        throw PayloadError(
          'bad-active-course',
          `completedAt ${active.completedAt} is outside the sane Unix-seconds range ` +
          `${MIN_COMPLETED_AT}-${MAX_COMPLETED_AT} (2020-2100) — looks like milliseconds or a corrupt value`
        );
      }
      activeCourse = { id: active.id, categoryId: active.category, name: active.name, completedAt: active.completedAt };
    }

    return {
      courses: courses,
      categories: categories,
      activeCourse: activeCourse,
      completedIds: completedIds,
      reduction: deriveReduction(courses),
    };
  }

  // parentId is Torn's own prerequisite graph and chains arbitrarily deep —
  // CMT1520 → CMT2570 → CMT2128 → CMT2129. A tier-based model would permit
  // queues the player cannot actually follow.
  //
  // The one rule not in the payload: a tier-3 bachelor carries parentId null
  // but requires every tier-2 course in its category.
  function unmetPrerequisites(courseId, completedIds, courses) {
    const course = courses.get(courseId);
    if (!course) return [-1];

    const missing = new Set();

    if (course.tier === 3) {
      for (const other of courses.values()) {
        if (other.categoryId === course.categoryId && other.tier === 2 && !completedIds.has(other.id)) {
          missing.add(other.id);
        }
      }
    }

    const seen = new Set();
    let parentId = course.parentId;
    while (parentId !== null && parentId !== undefined) {
      if (completedIds.has(parentId)) break;
      if (seen.has(parentId)) break;
      seen.add(parentId);
      const parent = courses.get(parentId);
      if (!parent) { missing.add(-1); break; }
      missing.add(parent.id);
      parentId = parent.parentId;
    }

    return [...missing].sort((a, b) => a - b);
  }

  // Returns the full transitive prerequisite chain for courseId, ending with
  // courseId itself, in an order the player can actually follow: every
  // requirement is emitted before anything that depends on it. Already-
  // completed courses are excluded entirely. A post-order depth-first walk —
  // visit a course's direct requirements first, then emit the course — using
  // the same visiting-set cycle guard as unmetPrerequisites, so a corrupt or
  // cyclic parentId graph terminates instead of recursing forever. `done`
  // tracks courses already emitted so a shared ancestor (e.g. every tier-2
  // course in a category sharing one tier-1 parent) is only emitted once.
  function requiredCoursesFor(courseId, completedIds, courses) {
    const result = [];
    const done = new Set();
    const visiting = new Set();

    function visit(id) {
      if (completedIds.has(id)) return;
      if (done.has(id)) return;
      if (visiting.has(id)) return;
      const course = courses.get(id);
      if (!course) return;

      visiting.add(id);

      if (course.parentId !== null && course.parentId !== undefined) {
        visit(course.parentId);
      }
      if (course.tier === 3) {
        for (const other of courses.values()) {
          if (other.categoryId === course.categoryId && other.tier === 2 && !completedIds.has(other.id)) {
            visit(other.id);
          }
        }
      }

      visiting.delete(id);
      done.add(id);
      result.push(id);
    }

    visit(courseId);
    return result;
  }

  // What the player will have finished by the time a *plan* starts, as opposed
  // to what they have finished today. The two differ by exactly one thing: the
  // course being served right now. Nothing queued can begin before it ends —
  // schedule() starts the queue at activeCourse.completedAt — so for judging a
  // plan the in-progress course is done.
  //
  // unmetPrerequisites answers the other question, "can I start this today?",
  // where an in-progress course is correctly *not* completed
  // (tests/prereq.test.js pins that, deliberately). Neither is a softening of
  // the other: the caller picks the set that matches the question it is asking.
  // Without this, the Biology bachelor is unqueueable for as long as any
  // Biology tier-2 course is running — which, for a player on the education
  // page, is nearly always — and the panel would answer "all remaining courses"
  // with a plan it then refuses to date.
  //
  // Only the course `activeCourse` actually names is promoted — gated on
  // `activeCourse.id`, not on `status` alone, since the two come from
  // independent parts of the payload. This function does not itself check
  // `completedAt`; that a named `activeCourse` carries a valid one is a
  // `parsePayload` invariant enforced before any caller reaches here, not
  // re-verified by this one (call it directly with `{id: 34}` and it
  // promotes). A course marked inProgress that activeCourse does not name has
  // no completion time anywhere, so schedule() bills none of its remaining
  // weeks. Promoting it would print a finish date short by up to a whole
  // course. Refusing to promote it costs only the withheld date the panel
  // would have shown before any of this existed, which is the trade this
  // codebase makes every time: no date beats a wrong one.
  function plannedCompletions(completedIds, courses, activeCourse) {
    const done = new Set(completedIds);
    if (!activeCourse || !isInt(activeCourse.id)) return done;
    const course = courses.get(activeCourse.id);
    if (course && course.status === 'inProgress') done.add(course.id);
    return done;
  }

  // "Queue everything I have not done" — the question the community guides and
  // the old PHP tool both centred on. Folding requiredCoursesFor over the
  // catalogue rather than sorting the courses directly means the result is a
  // queue validateQueue accepts, by construction rather than by argument.
  function allRemainingCourses(completedIds, courses, activeCourse) {
    // The active course is treated as done, so requiredCoursesFor never emits
    // it and a course gated on it is still reachable. Completed and in-progress
    // courses are skipped as roots for the same reason buildPanelModel drops
    // them from a stored queue: neither is work remaining.
    const done = plannedCompletions(completedIds, courses, activeCourse);
    const queued = new Set();
    const out = [];
    for (const course of courses.values()) {
      if (course.status === 'completed' || course.status === 'inProgress') continue;
      if (queued.has(course.id)) continue;
      for (const id of requiredCoursesFor(course.id, done, courses)) {
        if (queued.has(id)) continue;
        // A belt to plannedCompletions' braces, and the only thing standing
        // between a caller that forgot activeCourse and an in-progress course
        // in the queue. Such a caller gets a queue the panel refuses to date
        // (the gated course reports as unmet) rather than one that quietly
        // counts weeks the player is already serving.
        const required = courses.get(id);
        if (required && required.status === 'inProgress') continue;
        queued.add(id);
        out.push(id);
      }
    }
    return out;
  }

  function validateQueue(queue, completedIds, courses) {
    const done = new Set(completedIds);
    const problems = [];
    for (const courseId of queue) {
      const missing = unmetPrerequisites(courseId, done, courses);
      if (missing.length > 0) problems.push({ courseId: courseId, missing: missing });
      done.add(courseId);
    }
    return problems;
  }

  // Ordering does NOT change the finish date. Courses run one at a time, so
  // the total is a sum, and a sum is order-independent — tests/engine.test.js
  // asserts that property directly and tests/ordering.test.js re-asserts it for
  // every mode. What ordering changes is time-to-benefit: how early each perk
  // starts paying off. Several community guides blur the two. This must not.
  //
  // Three modes, not four: days-per-bonus is parked (docs/designs/
  // v0.2.0-scope.md § H2) because the payload offers two candidate meanings of
  // "bonus" that sort the catalogue differently, and a mode that means one of
  // two things is worse than no mode. It must stay out of this list — an
  // unknown id falls back to as-listed, which is the behaviour it gets today.
  //
  // This list is the single source of truth for the mode vocabulary:
  // ORDER_MODES (which normaliseSettings validates against) is derived from it
  // below, so a mode cannot exist in the dropdown and be rejected by storage.
  const ORDER_MODE_LABELS = [
    { id: 'as-listed', label: 'As listed' },
    { id: 'shortest-first', label: 'Shortest first' },
    { id: 'unlocks-first', label: 'Unlocks the most first' },
    { id: 'focus', label: 'My focus first' },
  ];

  // The focus taxonomy: which courses deliver which player-facing benefit.
  //
  // Static rather than parsed, because 101 learningOutcomes strings carry 88
  // distinct forms — a classification is a human judgement, not a regex. Each
  // row records the outcome string it was classified FROM, so focusRegistry
  // can tell a live payload that the judgement no longer applies.
  //
  // Keyed by (category, selection): `Strength` exists under both
  // `Passive Stat Bonus` and `Gym Gain Bonus`, and they are different
  // quantities that must never merge.
  const FOCUS_TAXONOMY = Object.freeze([
    Object.freeze({ category: "Unlocks & Abilities", selection: "Amulet Finding", unit: "none", magnitude: null, courseId: 20, outcome: "Gain the ability to find Senet board pieces and amulets" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Anonymous Cash Transfers", unit: "none", magnitude: null, courseId: 62, outcome: "Gain the ability to send mails and cash anonymously" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Anonymous Mail", unit: "none", magnitude: null, courseId: 62, outcome: "Gain the ability to send mails and cash anonymously" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Armored Virus Coding", unit: "none", magnitude: null, courseId: 56, outcome: "Gain the ability to code Armored, Stealth, and Firewalk viruses" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Asian Sculpture Finding", unit: "none", magnitude: null, courseId: 19, outcome: "Gain the ability to find Asian sculptures and Companion pages" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Bail Others", unit: "none", magnitude: null, courseId: 90, outcome: "Gain the ability to buy yourself and others out of jail while you are in jail yourself" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Bail Self", unit: "none", magnitude: null, courseId: 90, outcome: "Gain the ability to buy yourself and others out of jail while you are in jail yourself" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Blood Delivery", unit: "none", magnitude: null, courseId: 127, outcome: "Ability to withdraw and deliver blood" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Blood Withdrawal", unit: "none", magnitude: null, courseId: 127, outcome: "Ability to withdraw and deliver blood" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Bootlegging Website Creation", unit: "none", magnitude: null, courseId: 23, outcome: "Unlock the ability to create websites for use in Bootlegging and Scamming" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Companion Page Finding", unit: "none", magnitude: null, courseId: 19, outcome: "Gain the ability to find Asian sculptures and Companion pages" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Company Size Upgrades", unit: "none", magnitude: null, courseId: 13, outcome: "Unlock new size, storage size & staff room upgrades for your company" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Company Staff Room Upgrades", unit: "none", magnitude: null, courseId: 13, outcome: "Unlock new size, storage size & staff room upgrades for your company" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Company Storage Upgrades", unit: "none", magnitude: null, courseId: 13, outcome: "Unlock new size, storage size & staff room upgrades for your company" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Cracking Crime", unit: "none", magnitude: null, courseId: 52, outcome: "Unlock the Cracking crime" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Driving Crimes", unit: "none", magnitude: null, courseId: 113, outcome: "Unlock driving related crimes (Crimes 1.0)" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Firewalk Virus Coding", unit: "none", magnitude: null, courseId: 56, outcome: "Gain the ability to code Armored, Stealth, and Firewalk viruses" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Hacking Crimes (Crimes 1.0)", unit: "none", magnitude: null, courseId: 54, outcome: "Unlock hacking crimes (Crimes 1.0)" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Jail Escape Evasion", unit: "none", magnitude: null, courseId: 89, outcome: "Reduce the chance of being caught when trying to escape from jail" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Jail Escape Nerve Use", unit: "none", magnitude: null, courseId: 99, outcome: "Use less nerve when trying to escape from jail" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Kick Attack", unit: "none", magnitude: null, courseId: 72, outcome: "Unlock kick attack when in a battle" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Medieval Coin Finding", unit: "none", magnitude: null, courseId: 18, outcome: "Gain the ability to find medieval coins" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Museum Access", unit: "none", magnitude: null, courseId: 21, outcome: "Unlock the museum, sets of artifacts and other collectibles can be exchanged here for points" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Needle Equipment", unit: "none", magnitude: null, courseId: 42, outcome: "Gain the ability to equip needles in your temporary slot" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Polymorphic Virus Coding", unit: "none", magnitude: null, courseId: 53, outcome: "Gain the ability to code Polymorphic and Tunneling viruses" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Scamming Email Extraction", unit: "none", magnitude: null, courseId: 130, outcome: "Unlock the extraction of email addresses through data breaches in Scamming" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Scamming Email Extraction", unit: "none", magnitude: null, courseId: 131, outcome: "Unlock the development of scrapers to extract email addresses from websites for use in Scamming" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Scamming Response Range Indicators", unit: "none", magnitude: null, courseId: 132, outcome: "Unlock response range indicators in Scamming" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Scamming Website Creation", unit: "none", magnitude: null, courseId: 23, outcome: "Unlock the ability to create websites for use in Bootlegging and Scamming" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Senet Board Piece Finding", unit: "none", magnitude: null, courseId: 20, outcome: "Gain the ability to find Senet board pieces and amulets" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Simple Virus Coding", unit: "none", magnitude: null, courseId: 52, outcome: "Gain the ability to code Simple viruses" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Sports Shop Access", unit: "none", magnitude: null, courseId: 126, outcome: "Unlock the sports shop" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Stealth Virus Coding", unit: "none", magnitude: null, courseId: 56, outcome: "Gain the ability to code Armored, Stealth, and Firewalk viruses" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Tunneling Virus Coding", unit: "none", magnitude: null, courseId: 53, outcome: "Gain the ability to code Polymorphic and Tunneling viruses" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Weapon Experience Accuracy", unit: "none", magnitude: null, courseId: 87, outcome: "Start gaining weapon experience, specializing in individual weapons for increased damage and accuracy" }),
    Object.freeze({ category: "Unlocks & Abilities", selection: "Weapon Experience Damage", unit: "none", magnitude: null, courseId: 87, outcome: "Start gaining weapon experience, specializing in individual weapons for increased damage and accuracy" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Defense", unit: "percent", magnitude: 1, courseId: 71, outcome: "Gain a 1% passive bonus to defense" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Defense", unit: "percent", magnitude: 2, courseId: 73, outcome: "Gain a 2% passive bonus to defense" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Defense", unit: "percent", magnitude: 3, courseId: 74, outcome: "Gain a 3% passive bonus to defense" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Defense", unit: "percent", magnitude: 1, courseId: 26, outcome: "Gain a 1% passive bonus to defense" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Defense", unit: "percent", magnitude: 2, courseId: 32, outcome: "Gain a 2% passive bonus to defense" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Defense", unit: "percent", magnitude: 2, courseId: 50, outcome: "Gain a 2% passive bonus to defense and dexterity" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Dexterity", unit: "percent", magnitude: 1, courseId: 104, outcome: "Gain a 1% passive bonus to dexterity" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Dexterity", unit: "percent", magnitude: 1, courseId: 108, outcome: "Gain a 1% passive bonus to dexterity" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Dexterity", unit: "percent", magnitude: 1, courseId: 64, outcome: "Gain a 1% passive bonus to dexterity" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Dexterity", unit: "percent", magnitude: 2, courseId: 65, outcome: "Gain a 2% passive bonus to dexterity" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Dexterity", unit: "percent", magnitude: 4, courseId: 66, outcome: "Gain a 4% passive bonus to dexterity" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Dexterity", unit: "percent", magnitude: 8, courseId: 67, outcome: "Gain an 8% passive bonus to dexterity" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Dexterity", unit: "percent", magnitude: 2, courseId: 50, outcome: "Gain a 2% passive bonus to defense and dexterity" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Speed", unit: "percent", magnitude: 1, courseId: 79, outcome: "Gain a 1% passive bonus to speed" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Speed", unit: "percent", magnitude: 2, courseId: 75, outcome: "Gain a 2% passive bonus to speed" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Speed", unit: "percent", magnitude: 3, courseId: 76, outcome: "Gain a 3% passive bonus to speed" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Speed", unit: "percent", magnitude: 1, courseId: 105, outcome: "Gain a 1% passive bonus to speed" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Speed", unit: "percent", magnitude: 3, courseId: 109, outcome: "Gain a 3% passive bonus to speed" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Speed", unit: "percent", magnitude: 1, courseId: 24, outcome: "Gain a 1% passive bonus to speed" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Speed", unit: "percent", magnitude: 1, courseId: 25, outcome: "Gain a 1% passive bonus to speed" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Speed", unit: "percent", magnitude: 2, courseId: 49, outcome: "Gain a 2% passive bonus to speed and strength" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Strength", unit: "percent", magnitude: 1, courseId: 106, outcome: "Gain a 1% passive bonus to strength" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Strength", unit: "percent", magnitude: 2, courseId: 107, outcome: "Gain a 2% passive bonus to strength" }),
    Object.freeze({ category: "Passive Stat Bonus", selection: "Strength", unit: "percent", magnitude: 2, courseId: 49, outcome: "Gain a 2% passive bonus to speed and strength" }),
    Object.freeze({ category: "Combat Bonuses", selection: "All Melee Damage", unit: "percent", magnitude: 2, courseId: 17, outcome: "Gain a 2% bonus to all melee damage" }),
    Object.freeze({ category: "Combat Bonuses", selection: "All Weapon Damage", unit: "percent", magnitude: 1, courseId: 35, outcome: "Gain a 1% damage bonus to all weapons" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Ammo Conservation", unit: "percent", magnitude: 5, courseId: 31, outcome: "Gain a 5% bonus to ammo conservation" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Ammo Conservation", unit: "percent", magnitude: 20, courseId: 33, outcome: "Gain a 20% bonus to ammo conservation" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Critical Hit Chance", unit: "percent", magnitude: 3, courseId: 41, outcome: "Gain a 3% chance increase of achieving a critical hit" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Escape Prevention Speed", unit: "percent", magnitude: 25, courseId: 111, outcome: "Gain a 25% increase in speed during an opponent's escape attempt" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Heavy Artillery Accuracy", unit: "flat", magnitude: 1, courseId: 86, outcome: "Gain a +1.00 accuracy increase with Heavy Artillery" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Japanese Blade Damage", unit: "percent", magnitude: 10, courseId: 16, outcome: "Gain a 10% damage increase with Japanese blade weapons" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Machine Gun Accuracy", unit: "flat", magnitude: 1, courseId: 82, outcome: "Gain a +1.00 accuracy increase with Machine Guns" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Opponent Stealth Reduction", unit: "flat", magnitude: 0.5, courseId: 40, outcome: "Decrease an opponent's stealthiness by 0.5" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Pistol Accuracy", unit: "flat", magnitude: 1, courseId: 84, outcome: "Gain a +1.00 accuracy increase with Pistols" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Rifle Accuracy", unit: "flat", magnitude: 1, courseId: 85, outcome: "Gain a +1.00 accuracy increase with Rifles" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Shotgun Accuracy", unit: "flat", magnitude: 1, courseId: 125, outcome: "Gain a +1.00 accuracy increase with Shotguns" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Submachine Gun Accuracy", unit: "flat", magnitude: 1, courseId: 83, outcome: "Gain a +1.00 accuracy increase with Submachine guns" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Temporary Weapon Accuracy", unit: "flat", magnitude: 1, courseId: 116, outcome: "Gain a +1.00 accuracy increase with Temporary weapons" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Temporary Weapon Damage", unit: "percent", magnitude: 5, courseId: 119, outcome: "Gain a 5% damage increase with Temporary weapons" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Throat Hit Damage", unit: "percent", magnitude: 10, courseId: 38, outcome: "Gain a 10% damage increase when hitting an opponent's throat" }),
    Object.freeze({ category: "Combat Bonuses", selection: "Unarmed Damage", unit: "percent", magnitude: 100, courseId: 77, outcome: "Gain a 100% increase in damage dealt when using fists alone" }),
    Object.freeze({ category: "Company Bonuses", selection: "Advertising Effectiveness", unit: "percent", magnitude: 3, courseId: 4, outcome: "Gain a 3% increase in advertising effectiveness for your company" }),
    Object.freeze({ category: "Company Bonuses", selection: "Advertising Effectiveness", unit: "percent", magnitude: 3, courseId: 100, outcome: "Gain a 3% increase in advertising effectiveness for your company" }),
    Object.freeze({ category: "Company Bonuses", selection: "Company Productivity", unit: "percent", magnitude: 2, courseId: 10, outcome: "Gain 2% productivity for your company" }),
    Object.freeze({ category: "Company Bonuses", selection: "Company Productivity", unit: "percent", magnitude: 2, courseId: 12, outcome: "Gain 2% productivity for your company" }),
    Object.freeze({ category: "Company Bonuses", selection: "Company Productivity", unit: "percent", magnitude: 2, courseId: 2, outcome: "Gain 2% productivity for your company" }),
    Object.freeze({ category: "Company Bonuses", selection: "Company Productivity", unit: "percent", magnitude: 2, courseId: 5, outcome: "Gain 2% productivity for your company" }),
    Object.freeze({ category: "Company Bonuses", selection: "Company Productivity", unit: "percent", magnitude: 2, courseId: 8, outcome: "Gain 2% productivity for your company" }),
    Object.freeze({ category: "Company Bonuses", selection: "Company Productivity", unit: "percent", magnitude: 1, courseId: 28, outcome: "Gain 1% productivity for your company" }),
    Object.freeze({ category: "Company Bonuses", selection: "Employee Effectiveness", unit: "flat", magnitude: 5, courseId: 3, outcome: "Gain 5 effectiveness for the employees in your company" }),
    Object.freeze({ category: "Company Bonuses", selection: "Employee Effectiveness", unit: "flat", magnitude: 7, courseId: 6, outcome: "Gain 7 effectiveness for the employees in your company" }),
    Object.freeze({ category: "Company Bonuses", selection: "Employee Working Stats", unit: "percent", magnitude: 20, courseId: 11, outcome: "Gain a 20% passive bonus to employee working stats in your company" }),
    Object.freeze({ category: "Company Bonuses", selection: "Perceived Product Value", unit: "percent", magnitude: 10, courseId: 7, outcome: "Gain 10% perceived product value for your company" }),
    Object.freeze({ category: "Company Bonuses", selection: "Perceived Product Value", unit: "percent", magnitude: 5, courseId: 9, outcome: "Gain 5% perceived product value for your company" }),
    Object.freeze({ category: "Crime & Jail Bonuses", selection: "Bail Cost Discount", unit: "percent", magnitude: 5, courseId: 93, outcome: "Gain a 5% discount when buying people out of jail" }),
    Object.freeze({ category: "Crime & Jail Bonuses", selection: "Bail Cost Discount", unit: "percent", magnitude: 10, courseId: 98, outcome: "Gain a 10% discount when buying people out of jail" }),
    Object.freeze({ category: "Crime & Jail Bonuses", selection: "Bail Cost Discount", unit: "percent", magnitude: 50, courseId: 102, outcome: "Gain two bonuses: Busting is 50% easier and bailing is 50% cheaper" }),
    Object.freeze({ category: "Crime & Jail Bonuses", selection: "Busting", unit: "percent", magnitude: 5, courseId: 92, outcome: "Gain a 5% bonus to your skill in busting" }),
    Object.freeze({ category: "Crime & Jail Bonuses", selection: "Busting", unit: "percent", magnitude: 10, courseId: 97, outcome: "Gain a 10% bonus to your skill in busting" }),
    Object.freeze({ category: "Crime & Jail Bonuses", selection: "Busting", unit: "percent", magnitude: 50, courseId: 102, outcome: "Gain two bonuses: Busting is 50% easier and bailing is 50% cheaper" }),
    Object.freeze({ category: "Crime & Jail Bonuses", selection: "Crime Experience Gain", unit: "percent", magnitude: 10, courseId: 69, outcome: "Gain a 10% increase to crime exp & skill progression" }),
    Object.freeze({ category: "Crime & Jail Bonuses", selection: "Crime Skill Progression", unit: "percent", magnitude: 10, courseId: 69, outcome: "Gain a 10% increase to crime exp & skill progression" }),
    Object.freeze({ category: "Crime & Jail Bonuses", selection: "Hacking Crime Success Rate", unit: "percent", magnitude: 10, courseId: 61, outcome: "Gain a 10% increase in hacking crime success rate (Crimes 1.0)" }),
    Object.freeze({ category: "Crime & Jail Bonuses", selection: "Property Purchase Discount", unit: "percent", magnitude: 5, courseId: 91, outcome: "Gain a 5% discount when buying properties from the estate agents" }),
    Object.freeze({ category: "Gym Gain Bonus", selection: "Defense", unit: "percent", magnitude: 1, courseId: 46, outcome: "Gain a 1% bonus to defense gains in the gym" }),
    Object.freeze({ category: "Gym Gain Bonus", selection: "Defense", unit: "percent", magnitude: 1, courseId: 51, outcome: "Gain a further 1% boost in all gym gains" }),
    Object.freeze({ category: "Gym Gain Bonus", selection: "Dexterity", unit: "percent", magnitude: 1, courseId: 47, outcome: "Gain a 1% bonus to dexterity gains in the gym" }),
    Object.freeze({ category: "Gym Gain Bonus", selection: "Dexterity", unit: "percent", magnitude: 1, courseId: 51, outcome: "Gain a further 1% boost in all gym gains" }),
    Object.freeze({ category: "Gym Gain Bonus", selection: "Speed", unit: "percent", magnitude: 1, courseId: 45, outcome: "Gain a 1% bonus to speed gains in the gym" }),
    Object.freeze({ category: "Gym Gain Bonus", selection: "Speed", unit: "percent", magnitude: 1, courseId: 51, outcome: "Gain a further 1% boost in all gym gains" }),
    Object.freeze({ category: "Gym Gain Bonus", selection: "Strength", unit: "percent", magnitude: 1, courseId: 44, outcome: "Gain a 1% bonus to strength gains in the gym" }),
    Object.freeze({ category: "Gym Gain Bonus", selection: "Strength", unit: "percent", magnitude: 1, courseId: 51, outcome: "Gain a further 1% boost in all gym gains" }),
    Object.freeze({ category: "Computing Bonuses", selection: "Rig Component Heat Reduction", unit: "percent", magnitude: 25, courseId: 57, outcome: "Gain a 25% reduction in heat generated by rig components" }),
    Object.freeze({ category: "Computing Bonuses", selection: "Rig Overclocking Limit", unit: "percent", magnitude: 30, courseId: 128, outcome: "Unlock rig overclocking up to 30%" }),
    Object.freeze({ category: "Computing Bonuses", selection: "Rig Overclocking Limit", unit: "percent", magnitude: 50, courseId: 129, outcome: "Unlock rig overclocking up to 50%" }),
    Object.freeze({ category: "Computing Bonuses", selection: "Virus Coding Time Reduction", unit: "percent", magnitude: 20, courseId: 58, outcome: "Gain a 20% decrease in virus coding times" }),
    Object.freeze({ category: "Computing Bonuses", selection: "Virus Coding Time Reduction", unit: "percent", magnitude: 10, courseId: 60, outcome: "Gain a 10% decrease in virus coding times" }),
    Object.freeze({ category: "General Progression Bonuses", selection: "Awareness", unit: "percent", magnitude: 10, courseId: 68, outcome: "Gain a 10% increase to awareness" }),
    Object.freeze({ category: "General Progression Bonuses", selection: "Education Working Stat Rewards", unit: "percent", magnitude: 10, courseId: 121, outcome: "Gain a 10% working stat increase bonus for all future educations that are completed" }),
    Object.freeze({ category: "General Progression Bonuses", selection: "Hunting Bonus", unit: "percent", magnitude: 15, courseId: 120, outcome: "Gain a 15% hunting bonus" }),
    Object.freeze({ category: "Medical Effectiveness", selection: "Medical Item Effectiveness", unit: "percent", magnitude: 10, courseId: 36, outcome: "Gain a bonus of 10% to medical item effectiveness" }),
    Object.freeze({ category: "Medical Effectiveness", selection: "Medical Item Effectiveness", unit: "percent", magnitude: 10, courseId: 37, outcome: "Gain a further 10% bonus to medical item effectiveness" }),
    Object.freeze({ category: "Medical Effectiveness", selection: "Needle Effectiveness", unit: "percent", magnitude: 10, courseId: 48, outcome: "Gain a 10% increase in needle effectiveness" }),
  ]);

  // A course in the catalogue whose outcome strings the taxonomy does not
  // account for. Reported, never guessed at: a silent zero here would rank a
  // real benefit as worthless.
  function focusRegistry(courses) {
    const map = (courses instanceof Map) ? courses : new Map();
    const entries = [];
    let stale = 0;
    const claimed = new Map();   // courseId -> Set of outcome strings the taxonomy claims

    for (const row of FOCUS_TAXONOMY) {
      const course = map.get(row.courseId);
      const outcomes = (course && Array.isArray(course.learningOutcomes)) ? course.learningOutcomes : null;
      if (!outcomes || outcomes.indexOf(row.outcome) === -1) { stale += 1; continue; }
      entries.push(row);
      if (!claimed.has(row.courseId)) claimed.set(row.courseId, new Set());
      claimed.get(row.courseId).add(row.outcome);
    }

    let unmapped = 0;
    for (const course of map.values()) {
      const outcomes = Array.isArray(course.learningOutcomes) ? course.learningOutcomes : [];
      const known = claimed.get(course.id);
      for (const o of outcomes) {
        if (!known || !known.has(o)) unmapped += 1;
      }
    }

    return { entries, stale, unmapped, unclassified: 0 };
  }

  // Working stats are the one benefit Torn states in a machine-readable form:
  // 294 lines across all 131 courses, 100% parse against this shape. Unlike
  // learningOutcomes they need no taxonomy, which is why they are computed
  // rather than classified.
  const WORKING_STATS = Object.freeze(['intelligence', 'endurance', 'manual labor']);
  const WORKING_STAT_RE = /^Gain ([\d,.]+) (.+?) upon completion$/;

  function workingStatsFor(course) {
    const out = new Map();
    const gains = (course && Array.isArray(course.workingStatsGain)) ? course.workingStatsGain : [];
    for (const line of gains) {
      if (typeof line !== 'string') continue;
      const m = WORKING_STAT_RE.exec(line);
      if (!m) continue;
      const n = Number(m[1].replace(/,/g, ''));
      if (!isFinite(n)) continue;
      const stat = m[2];
      if (WORKING_STATS.indexOf(stat) === -1) continue;
      out.set(stat, (out.get(stat) || 0) + n);
    }
    return out;
  }

  const FOCUS_WORKING_STATS = 'Working Stats';

  // (category, selection), never selection alone — see FOCUS_TAXONOMY's note.
  function focusKey(category, selection) { return `${category} ${selection}`; }

  // One Map per focus rather than one combined score: combining is exactly the
  // invented exchange rate this feature exists to avoid. The caller ranks
  // lexicographically over the array.
  //
  // Keyed by course id, so a course reached by two rows of the same selection
  // is one entry carrying the summed magnitude — a split course is one course.
  function focusScores(focuses, courses) {
    const map = (courses instanceof Map) ? courses : new Map();
    const reg = focusRegistry(map);
    const byKey = new Map();
    for (const row of reg.entries) {
      const k = focusKey(row.category, row.selection);
      if (!byKey.has(k)) byKey.set(k, new Map());
      const scores = byKey.get(k);
      const n = isFinite(row.magnitude) ? row.magnitude : 0;
      scores.set(row.courseId, (scores.get(row.courseId) || 0) + n);
    }

    const list = Array.isArray(focuses) ? focuses : [];
    return list.map(function (f) {
      const category = f && f.category;
      const selection = f && f.selection;
      if (category === FOCUS_WORKING_STATS) {
        const out = new Map();
        for (const course of map.values()) {
          const n = workingStatsFor(course).get(selection);
          if (n) out.set(course.id, n);
        }
        return out;
      }
      return byKey.get(focusKey(category, selection)) || new Map();
    });
  }

  // Selections whose catalogue total cannot honestly be stated. Each is a
  // property of Torn's own wording, recorded here rather than inferred:
  // weapon experience has no ceiling, overclocking values are successive
  // limits rather than additive bonuses, and a "further" bonus may be
  // cumulative in a way its magnitude alone does not say.
  const FOCUS_UNSTATABLE = Object.freeze(['Weapon Experience Damage', 'Weapon Experience Accuracy']);

  // What a focus still has left, out of its catalogue total — per selection,
  // never summed across selections (a percent row and a flat-stat row are
  // incomparable units, the same defect focusScores exists to avoid).
  // `completedIds` is the "already banked" set, deliberately not
  // `plannedCompletions`: this states what has actually been earned, not what
  // will have been earned once a plan starts.
  function focusTotals(focus, courses, completedIds) {
    const map = (courses instanceof Map) ? courses : new Map();
    const done = (completedIds instanceof Set) ? completedIds : new Set();
    const category = focus && focus.category;
    const selection = focus && focus.selection;

    if (category === FOCUS_WORKING_STATS) {
      let total = 0;
      let remaining = 0;
      for (const course of map.values()) {
        const n = workingStatsFor(course).get(selection) || 0;
        total += n;
        if (!done.has(course.id)) remaining += n;
      }
      return { unit: 'flat', total, remaining, statable: true };
    }

    const rows = focusRegistry(map).entries.filter(function (r) {
      return r.category === category && r.selection === selection;
    });
    const statable = FOCUS_UNSTATABLE.indexOf(selection) === -1;
    const unit = (!statable || rows.some(function (r) { return r.unit === 'none'; })) ? 'count' : (rows[0] ? rows[0].unit : 'count');

    // By course, not by row: a course reached twice by one selection is one
    // course, and counting its magnitude twice would overstate the total.
    const byCourse = new Map();
    for (const r of rows) {
      byCourse.set(r.courseId, (byCourse.get(r.courseId) || 0) + (isFinite(r.magnitude) ? r.magnitude : 0));
    }

    let total = 0;
    let remaining = 0;
    for (const [id, magnitude] of byCourse) {
      const value = (unit === 'count') ? 1 : magnitude;
      total += value;
      if (!done.has(id)) remaining += value;
    }
    return { unit, total, remaining, statable };
  }

  // Everything that has to be done before this course can be: the parentId
  // chain, plus the one rule the payload does not carry in parentId — a tier-3
  // bachelor requires every tier-2 course in its own category.
  //
  // The two rules COMPOSE, and that is the whole reason this is a closure
  // rather than two separate tests. A tier-1 root reaches its category's
  // bachelor only through the tier-2 courses between them, so asking "is the
  // target a tier-2 course in this bachelor's category?" as a second chance
  // after the parent walk misses every tier-1 root by exactly one — its own
  // bachelor. That was the defect in the first cut of dependentCount: uniform
  // across all twelve roots, invisible on today's catalogue because tier-1
  // counts (6-14) never cross tier-2's (1-2), and wrong the moment a rank band
  // is mixed. tests/ordering.test.js pins the exact counts now, and the mixed
  // band as its own case, rather than a floor that passes either way.
  //
  // `cache` is optional caller-supplied scratch, so a caller asking about many
  // courses over one catalogue walks each chain once. Omitted, the walk is
  // private and the answer is identical. Two contracts come with it:
  //
  //   1. It is keyed by course id ALONE, not by catalogue. One cache belongs to
  //      one `courses` map, and handing a cache warmed against a different one
  //      returns confidently wrong answers rather than failing. No caller in
  //      this file can — orderQueue creates its cache and drops it inside one
  //      call — but dependentCount is exported taking it, so the rule is
  //      written down rather than left to be inferred.
  //   2. The returned Set on a cache hit IS the cached instance, not a copy.
  //      Every caller reads it and nothing writes to it; that has to stay true,
  //      or one caller's mutation silently rewrites another's graph.
  function upstreamOf(courseId, courses, cache) {
    if (cache && cache.has(courseId)) return cache.get(courseId);
    const seen = new Set();
    const stack = [courseId];
    // `seen` is the cycle guard as well as the result: nothing is pushed twice,
    // so a corrupt parentId loop terminates the same way unmetPrerequisites'
    // does.
    while (stack.length > 0) {
      const course = courses.get(stack.pop());
      if (!course) continue;
      const parentId = course.parentId;
      if (parentId !== null && parentId !== undefined && !seen.has(parentId)) {
        seen.add(parentId);
        stack.push(parentId);
      }
      if (course.tier === 3) {
        for (const other of courses.values()) {
          if (other.tier === 2 && other.categoryId === course.categoryId && !seen.has(other.id)) {
            seen.add(other.id);
            stack.push(other.id);
          }
        }
      }
    }
    if (cache) cache.set(courseId, seen);
    return seen;
  }

  // How many courses sit downstream of this one — the whole chain, not the
  // direct dependants. Asked of every course rather than built as a child
  // index, so there is one description of the prerequisite graph in this file
  // and unlocks-first cannot drift from what validateQueue enforces.
  function dependentCount(courseId, courses, cache) {
    const scratch = cache || new Map();
    let count = 0;
    for (const candidate of courses.values()) {
      if (candidate.id === courseId) continue;
      if (upstreamOf(candidate.id, courses, scratch).has(courseId)) count += 1;
    }
    return count;
  }

  // A topological sort over the same graph validateQueue checks, with a
  // per-mode tiebreak among the courses that are ready at each step. Kahn's
  // algorithm rather than a sort-then-repair, so the result is followable by
  // construction and an unsatisfiable queue degrades to appending the
  // remainder rather than looping.
  function orderQueue(queue, mode, courses, scoreMaps) {
    const chosen = ORDER_MODE_LABELS.some(function (m) { return m.id === mode; }) ? mode : 'as-listed';
    if (chosen === 'as-listed') return queue.slice();

    const inQueue = new Set(queue);
    // One walk of each course's prerequisite closure, shared by both passes
    // below: dependentCount is O(catalogue) per call, and asking it once per
    // queued course over a cold cache would walk the same chains 115 times.
    const upstream = new Map();

    // focus reads scoreMaps only when the mode is actually focus, so a caller
    // that forgets the fourth argument (or every other mode, which does not
    // take one) degrades to an empty vector rather than throwing.
    const maps = (chosen === 'focus' && Array.isArray(scoreMaps)) ? scoreMaps : [];

    // A course is ready when every prerequisite of it that is also in this
    // queue has already been placed. Both this and the rank read the same
    // closure, so readiness and "unlocks the most" cannot describe different
    // graphs.
    const rank = new Map();
    // A vector, not a number: lexicographic comparison is the only way to use
    // two focuses without inventing an exchange rate between them. Negated so
    // that "more of what you asked for" sorts first, matching shortest-first's
    // existing convention of a smaller rank winning.
    const rankVector = new Map();
    const prerequisitesIn = new Map();
    for (const id of queue) {
      const needed = [];
      for (const up of upstreamOf(id, courses, upstream)) {
        if (inQueue.has(up)) needed.push(up);
      }
      prerequisitesIn.set(id, needed);
      if (chosen === 'focus') {
        // dependentCount is O(catalogue) per call; focus has its own
        // ranking and never reads `rank`, so it must not pay for it.
        rankVector.set(id, maps.map(function (m) { return -(m.get(id) || 0); }));
      } else {
        const course = courses.get(id);
        rank.set(id, chosen === 'shortest-first'
          ? (course ? course.duration : 0)
          : -dependentCount(id, courses, upstream));
      }
    }

    const placed = new Set();
    const out = [];
    // Indices, not ids. Removing by id drops every copy of a duplicated course,
    // which would make shortest-first and as-listed disagree about the same
    // input — as-listed returns exactly what it was handed. loadPlan dedupes
    // and allRemainingCourses is duplicate-free, so no player reaches this;
    // the modes still have to answer the same question the same way.
    let remaining = queue.map(function (_, i) { return i; });

    while (remaining.length > 0) {
      const ready = remaining.filter(function (i) {
        return prerequisitesIn.get(queue[i]).every(function (p) { return placed.has(p); });
      });
      // Nothing ready means the queue itself is unsatisfiable — a cycle, or a
      // prerequisite outside the queue. Append the remainder in the order
      // given rather than spinning; validateQueue will report the real problem.
      if (ready.length === 0) {
        for (const i of remaining) out.push(queue[i]);
        break;
      }

      ready.sort(function (a, b) {
        if (chosen === 'focus') {
          // Lexicographic: compare the first focus, and only on a tie fall to
          // the next. Never summed — summing would invent an exchange rate
          // between two focuses that answer different questions, which is the
          // exact defect this feature exists to avoid.
          const va = rankVector.get(queue[a]);
          const vb = rankVector.get(queue[b]);
          for (let i = 0; i < va.length; i += 1) {
            if (va[i] !== vb[i]) return va[i] - vb[i];
          }
          return a - b;
        }
        const byRank = rank.get(queue[a]) - rank.get(queue[b]);
        if (byRank !== 0) return byRank;
        // The player's own ordering breaks a rank tie, so a queue whose courses
        // all score the same comes back exactly as it went in.
        //
        // This is NOT a hedge against sort stability — Array.prototype.sort has
        // been stable by specification since ES2019. It is here because
        // `ready` arriving in queue order is incidental: it holds only while
        // `remaining` is built by successive filters over an array, and a
        // refactor to a Set or a Map breaks it silently. No test can guard this
        // key (deleting it changes no output today), so this comment is the
        // guard, and it has to carry the reason that is actually true.
        return a - b;
      });

      const next = ready[0];
      out.push(queue[next]);
      placed.add(queue[next]);
      remaining = remaining.filter(function (i) { return i !== next; });
    }

    return out;
  }

  // actualDuration already carries the player's perk reduction, so the base
  // case is a sum. Timestamps are Unix seconds throughout, matching
  // activeCourse.completedAt.
  //
  // Order does not change finishesAt — a sum is order-independent. Ordering
  // changes time-to-benefit, which is a different question, answered by
  // orderQueue (this release, not a later one). tests/engine.test.js asserts
  // the order-independence directly; tests/ordering.test.js asserts every
  // mode against the same finishesAt.
  function schedule(options) {
    const courses = options.courses;
    const activeCourse = options.activeCourse;
    const queue = options.queue || [];
    const now = options.now;

    if (!Number.isFinite(now)) throw new Error('schedule: now is required (Unix seconds)');

    let cursor = activeCourse && Number.isFinite(activeCourse.completedAt)
      ? Math.max(activeCourse.completedAt, now)
      : now;

    const startsAt = cursor;
    const items = [];
    let totalSeconds = 0;

    for (const courseId of queue) {
      const course = courses.get(courseId);
      if (!course) throw new Error(`schedule: unknown course ${courseId}`);
      const itemStart = cursor;
      cursor += course.duration;
      totalSeconds += course.duration;
      items.push({ courseId: courseId, startsAt: itemStart, finishesAt: cursor });
    }

    return { startsAt: startsAt, items: items, finishesAt: cursor, totalSeconds: totalSeconds };
  }

  // "If I did only this degree, starting now, how long?" — so every box is
  // computed independently from the same starting point, pulling in whatever
  // prerequisites it needs and skipping what is done.
  //
  // The design this was written from predicted the boxes would NOT sum to the
  // all-courses box, on the theory that degrees share prerequisite courses.
  // Torn's catalogue says otherwise, and it is worth stating here rather than
  // leaving the next reader to rediscover it: no course has a parentId outside
  // its own category, and a tier-3 bachelor gates only on tier-2 courses in
  // its own category, so the twelve categories partition the catalogue exactly
  // and the boxes sum — in course count and in seconds. tests/grid.test.js
  // asserts the partition itself, so the day Torn breaks it the test names the
  // course that did.
  //
  // sumsDiffer is kept anyway, and is false today. Its reachability is a
  // property of a third-party catalogue that can change without a commit here,
  // which is exactly the branch worth keeping: if a prerequisite ever does
  // cross a category, a reader who adds the boxes up and gets a bigger number
  // than the all-courses box needs the UI to say why before concluding the
  // tool is broken. The test drives it by giving a real fixture a real
  // cross-category parent, not by flipping the flag.
  //
  // Declared below allRemainingCourses and schedule, both of which it calls.
  // Function declarations hoist, so this is not a requirement — it is the
  // reading order being kept honest.
  function buildDegreeGrid(options) {
    const courses = options.courses;
    const categories = options.categories;
    const completedIds = options.completedIds;
    const activeCourse = options.activeCourse;
    const now = options.now;

    const boxFor = function (key, name, bachelorPrefix, queue) {
      const result = schedule({ courses: courses, activeCourse: activeCourse, queue: queue, now: now });
      return {
        key: key,
        name: name,
        bachelorPrefix: bachelorPrefix,
        courseCount: queue.length,
        totalSeconds: result.totalSeconds,
        // schedule() starts its cursor at max(activeCourse.completedAt, now),
        // so an empty queue would otherwise report the active course's end as
        // this degree's finish date — a date for work it does not contain.
        finishesAt: queue.length > 0 ? result.finishesAt : now,
      };
    };

    const boxes = [];
    let summedCount = 0;

    // plannedCompletions, not completedIds. By the time any queued course runs,
    // the course now in progress has finished, because schedule() starts its
    // cursor at max(activeCourse.completedAt, now). Gating on today's
    // completions instead reports a phantom missing prerequisite for every
    // bachelor in the active course's category.
    //
    // Loop-invariant, so it is computed once rather than per category.
    const done = plannedCompletions(completedIds, courses, activeCourse);

    for (const category of categories) {
      const queued = new Set();
      const queue = [];
      // Torn ships exactly one tier-3 course per category, and the box title
      // names it — "Biology (BIO3420)" — as *the* degree. If a category ever
      // carries two, that claim is no longer true of either, so the label is
      // withheld and the box falls back to the bare category name rather than
      // naming whichever came last in the payload. Same trade the panel makes
      // with a finish date it cannot stand behind: no label beats a wrong one.
      let bachelorPrefix = null;
      let bachelorCount = 0;

      for (const courseId of category.courseIds) {
        const course = courses.get(courseId);
        if (!course) continue;
        if (course.tier === 3) {
          bachelorCount += 1;
          bachelorPrefix = bachelorCount === 1 ? course.prefix : null;
        }
        if (course.status === 'completed' || course.status === 'inProgress') continue;
        for (const id of requiredCoursesFor(courseId, done, courses)) {
          if (queued.has(id)) continue;
          const required = courses.get(id);
          if (required && required.status === 'inProgress') continue;
          queued.add(id);
          queue.push(id);
        }
      }

      summedCount += queue.length;
      boxes.push(boxFor(category.id, category.name, bachelorPrefix, queue));
    }

    const everything = allRemainingCourses(completedIds, courses, activeCourse);
    const allBox = boxFor('all', 'All courses', null, everything);
    boxes.push(allBox);

    return { boxes: boxes, sumsDiffer: summedCount > allBox.courseCount };
  }

  // Torn's own React tree carries the same education payload the endpoint
  // returns. Path 2 walks that tree when path 1 fails. The walk is the part
  // that can hang a tab, so it lives here as a pure function over a plain
  // object graph and gets tested against cyclic and adversarial input.
  function looksLikePayload(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (v.success !== true) return false;
    if (!Array.isArray(v.categories) || v.categories.length === 0) return false;
    const first = v.categories[0];
    return !!first && isInt(first.id) && Array.isArray(first.courses);
  }

  // One walk's budget, shared across every root the caller hands to
  // searchForPayload. The bound has to span the whole search, not each root
  // separately: several roots normally point into the same graph, so a
  // per-root budget silently multiplies the real ceiling by the root count
  // and the walk stops being bounded in any useful sense.
  //
  // `exhausted` distinguishes "walked the whole graph and it was not there"
  // from "ran out of budget before reaching the end". Reporting the second as
  // the first hands a later debug report the wrong diagnosis.
  function newWalkState() {
    return { seen: new Set(), visited: 0, exhausted: false };
  }

  // Breadth-first, so a payload sitting shallow is found before the walk
  // spends its budget deep in an unrelated subtree. Bounded on both axes and
  // cycle-guarded: an unbounded walk over a React tree does not terminate.
  //
  // `state` is optional; omitted, the walk gets a private budget. Callers with
  // more than one root must create one state with newWalkState() and pass the
  // same object to every call, so the node budget and the cycle guard are
  // shared rather than reset per root.
  function searchForPayload(root, limits, state) {
    const maxNodes = limits && isInt(limits.maxNodes) ? limits.maxNodes : 0;
    const maxDepth = limits && isInt(limits.maxDepth) ? limits.maxDepth : 0;
    if (maxNodes <= 0 || maxDepth <= 0) return null;

    const walk = state || newWalkState();
    const seen = walk.seen;
    let frontier = [root];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
      const nextFrontier = [];
      for (const node of frontier) {
        if (node === null || typeof node !== 'object') continue;
        if (seen.has(node)) continue;
        seen.add(node);
        walk.visited += 1;
        if (walk.visited > maxNodes) {
          walk.exhausted = true;
          return null;
        }

        // The probe reads properties off a host object, so it can trip a
        // throwing getter exactly as the key enumeration below can. A throw
        // here would abandon every remaining node and every remaining root,
        // so it is caught and the node is simply treated as not-a-payload —
        // its children are still worth walking.
        let matched = false;
        try { matched = looksLikePayload(node); } catch (e) { matched = false; }
        if (matched) return node;

        // Only own enumerable keys, and only object values. Getters on a host
        // object can throw or have side effects, so every read is guarded.
        let keys;
        try { keys = Object.keys(node); } catch (e) { continue; }
        for (const key of keys) {
          let value;
          try { value = node[key]; } catch (e) { continue; }
          if (value !== null && typeof value === 'object') nextFrontier.push(value);
        }
      }
      frontier = nextFrontier;
      depth += 1;
    }
    return null;
  }

  // Derived, never a second list: what storage accepts and what the dropdown
  // offers are the same vocabulary, and two hand-maintained copies of it drift
  // into a mode the player can pick and normaliseSettings then silently
  // refuses. ORDER_MODE_LABELS is the source.
  const ORDER_MODES = ORDER_MODE_LABELS.map(function (m) { return m.id; });
  const SETTINGS_DEFAULTS = {
    maxCooldownHours: 24,
    booksOwned: 0,
    bookPrice: 13500000,
    jobPoints: 0,
    orderMode: 'as-listed',
  };
  // Generous ceilings, present only to reject nonsense — a negative price or a
  // cooldown of a million hours is a typo, not a preference.
  const SETTINGS_BOUNDS = {
    maxCooldownHours: { min: 0, max: 8760 },
    booksOwned: { min: 0, max: 100000 },
    bookPrice: { min: 0, max: 1000000000000 },
    jobPoints: { min: 0, max: 1000000 },
  };

  function boundedInt(value, field) {
    const bounds = SETTINGS_BOUNDS[field];
    if (!isInt(value)) return SETTINGS_DEFAULTS[field];
    if (value < bounds.min || value > bounds.max) return SETTINGS_DEFAULTS[field];
    return value;
  }

  // Validated against the taxonomy itself rather than a separate list, so a
  // selection cannot be storable and unrankable at the same time. One per
  // category: two focuses in one category would be a tiebreak against itself.
  const FOCUS_CATEGORIES = Object.freeze(
    [FOCUS_WORKING_STATS].concat(FOCUS_TAXONOMY.map(function (r) { return r.category; }))
      .filter(function (c, i, a) { return a.indexOf(c) === i; })
  );

  function normaliseFocuses(raw) {
    if (!Array.isArray(raw)) return [];
    const known = new Set(FOCUS_TAXONOMY.map(function (r) { return focusKey(r.category, r.selection); }));
    for (const stat of WORKING_STATS) known.add(focusKey(FOCUS_WORKING_STATS, stat));

    const out = [];
    const seenCategory = new Set();
    for (const f of raw) {
      if (!f || typeof f !== 'object') continue;
      const category = f.category;
      const selection = f.selection;
      if (typeof category !== 'string' || typeof selection !== 'string') continue;
      if (!known.has(focusKey(category, selection))) continue;
      if (seenCategory.has(category)) continue;
      seenCategory.add(category);
      out.push({ category, selection });
    }
    return out;
  }

  // Priority is position, not a stored number. Keeping them as one thing is
  // what makes it impossible for the number beside a focus to disagree with
  // the order the queue is actually sorted in.
  //
  // A category holds one slot. Picking a different selection in a category the
  // player already chose swaps what fills the slot and leaves its number alone
  // — re-picking is a change of mind about the what, not about the how much.
  function toggleFocus(focuses, category, selection) {
    const list = Array.isArray(focuses) ? focuses.slice() : [];
    const at = list.findIndex(function (f) { return f.category === category; });
    if (at === -1) return list.concat([{ category, selection }]);
    if (list[at].selection === selection) {
      list.splice(at, 1);          // deselect; the splice is what closes the gap
      return list;
    }
    list[at] = { category, selection };
    return list;
  }

  // Move to a 1-based position, the way a numbered list reorders: pull it out,
  // put it back at the clamped index, everything else shifts around it. An
  // unknown focus is returned untouched rather than appended — a renumber is
  // not a way to select something.
  function setFocusPriority(focuses, category, selection, position) {
    const list = Array.isArray(focuses) ? focuses.slice() : [];
    const at = list.findIndex(function (f) {
      return f.category === category && f.selection === selection;
    });
    if (at === -1) return list;
    const target = isInt(position) ? Math.min(Math.max(position, 1), list.length) : 1;
    const [moved] = list.splice(at, 1);
    list.splice(target - 1, 0, moved);
    return list;
  }

  // Validated per field, never per object. A player who spent time entering
  // four numbers should not lose all four because one of them rotted.
  function normaliseSettings(raw) {
    const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const rawPerks = (source.perks && typeof source.perks === 'object' && !Array.isArray(source.perks))
      ? source.perks : {};

    // Merits run 0-20 in steps of 2; anything else is not a reading the game
    // can produce, so it is discarded rather than clamped.
    const merits = rawPerks.meritsPercent;
    const meritsOk = isInt(merits) && merits >= 0 && merits <= 20 && merits % 2 === 0;

    return {
      maxCooldownHours: boundedInt(source.maxCooldownHours, 'maxCooldownHours'),
      booksOwned: boundedInt(source.booksOwned, 'booksOwned'),
      bookPrice: boundedInt(source.bookPrice, 'bookPrice'),
      jobPoints: boundedInt(source.jobPoints, 'jobPoints'),
      perks: {
        meritsPercent: meritsOk ? merits : null,
        principal: typeof rawPerks.principal === 'boolean' ? rawPerks.principal : null,
        wsuBlock: typeof rawPerks.wsuBlock === 'boolean' ? rawPerks.wsuBlock : null,
      },
      orderMode: ORDER_MODES.indexOf(source.orderMode) !== -1 ? source.orderMode : SETTINGS_DEFAULTS.orderMode,
      focuses: normaliseFocuses(source.focuses),
    };
  }

  const SECONDS_PER_BOOK = 21600;       // a Book of Carols removes 6 hours of course time
  const BOOK_COOLDOWN_SECONDS = 21600;  // and adds 6 hours of booster cooldown
  // Derived, not asserted: the divisor in the closed form below IS the sum of
  // the two, and writing 43200 with a "6 + 6" comment beside it would leave the
  // relationship described rather than enforced.
  const BOOK_FIXED_POINT_SECONDS = SECONDS_PER_BOOK + BOOK_COOLDOWN_SECONDS;

  // Cooldown decays in real time, so over a long path the ceiling is set by the
  // total cooldown budget rather than by a single sitting:
  //
  //   budget over a path of length T = T + maxCooldown
  //   maxBooks = floor((T + maxCooldown) / 6h)
  //
  // But each Book also shortens T by 6h, so it is a fixed point, and the closed
  // form falls out as (baseTime + maxCooldown) / 12h. On the real 197-day path
  // with a 24h maximum that is 396 Books, halving it to about 98 days.
  function booksCeiling(options) {
    const opts = options || {};
    const base = opts.baseSeconds;
    const cooldown = opts.maxCooldownSeconds;
    if (!isInt(base) || !isInt(cooldown) || base < 0 || cooldown < 0) return 0;
    return Math.floor((base + cooldown) / BOOK_FIXED_POINT_SECONDS);
  }

  // Two figures, computed independently: what the player says they will spend,
  // and the floor from maximum possible use. The floor is NOT the planned date
  // minus leftovers, and it ships with its cost because "98 days for 5.35b" is
  // actionable where "98 days" is not.
  function planConsumables(options) {
    const opts = options || {};
    const base = isInt(opts.baseSeconds) && opts.baseSeconds >= 0 ? opts.baseSeconds : 0;
    const owned = isInt(opts.booksOwned) && opts.booksOwned >= 0 ? opts.booksOwned : 0;
    const price = isInt(opts.bookPrice) && opts.bookPrice >= 0 ? opts.bookPrice : 0;
    const ceiling = booksCeiling({ baseSeconds: base, maxCooldownSeconds: opts.maxCooldownSeconds });

    const usable = Math.min(owned, ceiling);
    const plannedSaving = Math.min(usable * SECONDS_PER_BOOK, base);
    const floorSaving = Math.min(ceiling * SECONDS_PER_BOOK, base);

    // Count and price the Books that actually buy the saving, never the ones
    // the cooldown budget would merely allow. The two diverge whenever the
    // clamp bites — a one-course queue with a large maximum cooldown has a
    // ceiling of hundreds of Books and room for seventeen — and quoting the
    // ceiling there prints a correct floor date beside a price inflated 43x,
    // on the one line whose whole purpose is that the two are trustworthy
    // together. Math.ceil, not floor: a partial Book still has to be bought.
    const plannedBooks = Math.ceil(plannedSaving / SECONDS_PER_BOOK);
    const floorBooks = Math.ceil(floorSaving / SECONDS_PER_BOOK);

    return {
      ceiling: ceiling,
      plannedBooks: plannedBooks,
      plannedSaving: plannedSaving,
      plannedSeconds: base - plannedSaving,
      floorBooks: floorBooks,
      floorSaving: floorSaving,
      floorSeconds: base - floorSaving,
      floorCost: floorBooks * price,
      // A price of zero is not a price. SETTINGS_BOUNDS.bookPrice.min is 0, so
      // a player who TYPES 0 gets there and it survives normalisation — the
      // arithmetic above is then honest and the sentence it produces ("the
      // floor costs $0") is the single most misleading thing this feature
      // could say.
      //
      // Clearing the field does NOT reach 0, and the guard would look like
      // dead code to anyone who tested that path: onSettingChange maps '' to
      // null, and boundedInt(null) returns the 13.5m default. An earlier
      // version of this comment claimed otherwise and was wrong. The reachable
      // path is a typed zero, and only that.
      //
      // Drawn here, in the engine, so every consumer inherits the distinction
      // rather than each one rediscovering that 0 means "unsaid".
      priceKnown: price > 0,
    };
  }

  // Torn players write money as 5.35b, not 5,346,000,000.
  //
  // A unit is reached either by the value passing it outright, or by the unit
  // BELOW it overflowing — 999,999,999 renders as 1000.00 in millions, and
  // "$1000m" is a unit nobody writes. The promotion tests the smaller unit's
  // overflow rather than this unit reaching 1, and the difference is not
  // cosmetic: "reaching 1" fires from 0.995, so 74 Books at 13.5m
  // ($999,000,000) would print $1b — a 0.1% overstatement in the one figure
  // this feature exists to make trustworthy, where $999m was both available
  // and exact. Nothing promotes into `k`, because below a thousand the player
  // is reading whole dollars and 999 must stay $999.
  const MONEY_UNITS = [[1e9, 'b'], [1e6, 'm'], [1e3, 'k']];
  function formatMoney(n) {
    if (!Number.isFinite(n)) return '$0';
    const abs = Math.abs(n);
    const trim = function (v) { return String(Number(v.toFixed(2))); };
    for (let i = 0; i < MONEY_UNITS.length; i++) {
      const scale = MONEY_UNITS[i][0];
      const below = i + 1 < MONEY_UNITS.length ? MONEY_UNITS[i + 1][0] : null;
      const reached = abs >= scale
        || (below !== null && Number((abs / below).toFixed(2)) >= 1000);
      if (reached) return `$${trim(n / scale)}${MONEY_UNITS[i][1]}`;
    }
    return `$${Math.round(n)}`;
  }

  // The three documented perks stack additively: merits 0-20 in 2% steps,
  // Principal rank 0 or 10, the WSU stock block 0 or 10. Totals below 10 and
  // above 30 have exactly one decomposition; the middle band has three or
  // four, and most players sit in it. Prefill only where the answer is
  // provably unique — a guess presented as a reading is worse than a blank.
  //
  // This enumerates rather than consulting a table, so the unique/ambiguous
  // boundaries cannot drift away from the rule they came from.
  function inferPerks(reduction) {
    function undetermined(reason) {
      return { determinate: false, totalPercent: null, candidates: 0, reason: reason };
    }

    // 'varies' is a claim about the player's account — that their reduction
    // genuinely differs course by course, which would mean Torn changed the
    // mechanic. Only evidence of two or more real ratios earns that word. A
    // missing, empty or malformed reduction is 'unreadable': we failed to read
    // it, which is a fact about us and must not be reported as a fact about
    // them. Number.isFinite, not typeof: a NaN ratio is a number and would
    // otherwise reach the panel as the sentence "Your NaN% reduction".
    if (!reduction || typeof reduction !== 'object') return undetermined('unreadable');
    const realRatios = Array.isArray(reduction.ratios) ? reduction.ratios.filter(function (r) { return Number.isFinite(r); }) : [];
    if (reduction.constant !== true || !Number.isFinite(reduction.ratio)) {
      return undetermined(realRatios.length >= 2 ? 'varies' : 'unreadable');
    }

    // The ratio is actualDuration/originDuration, so the reduction is its
    // complement. Round to whole percent: the ratio is a division of two
    // integers and carries float dust.
    const totalPercent = Math.round((1 - reduction.ratio) * 100);

    const matches = [];
    for (let merits = 0; merits <= 20; merits += 2) {
      for (const principal of [false, true]) {
        for (const wsuBlock of [false, true]) {
          const sum = merits + (principal ? 10 : 0) + (wsuBlock ? 10 : 0);
          if (sum === totalPercent) matches.push({ meritsPercent: merits, principal: principal, wsuBlock: wsuBlock });
        }
      }
    }

    if (matches.length === 0) {
      return { determinate: false, totalPercent: totalPercent, candidates: 0, reason: 'unrecognised' };
    }
    if (matches.length > 1) {
      return { determinate: false, totalPercent: totalPercent, candidates: matches.length, reason: 'ambiguous' };
    }
    return {
      determinate: true,
      totalPercent: totalPercent,
      meritsPercent: matches[0].meritsPercent,
      principal: matches[0].principal,
      wsuBlock: matches[0].wsuBlock,
      candidates: 1,
    };
  }

  // Built by allowlist, never blocklist. Every value in the report is read
  // from a named field below; an unrecognised field on the input is ignored
  // rather than serialised. A blocklist gets one field wrong eventually, and
  // the failure mode is a player pasting their session into a public forum.
  //
  // Deliberately absent: the anti-CSRF token, any raw response body, the
  // player's completed-course set, and the active course's timing.
  function buildDebugReport(input) {
    const src = (input && typeof input === 'object') ? input : {};
    const show = function (v) {
      if (v === null || v === undefined) return 'not recorded';
      if (v === true) return 'yes';
      if (v === false) return 'no';
      return String(v);
    };

    const settings = (src.settings && typeof src.settings === 'object') ? src.settings : null;
    const perks = (settings && settings.perks) ? settings.perks : {};

    const lines = [
      'Torn Education Scheduler — debug report',
      '',
      `Script version: ${show(src.scriptVersion)}`,
      `Userscript manager: ${show(src.manager)}`,
      `Browser: ${show(src.userAgent)}`,
      '',
      'Failure',
      `  Reason: ${show(src.failureReason)}`,
      `  Detail: ${show(src.failureDetail)}`,
      `  Data came from: ${show(src.source)}`,
      '',
      'Payload shape',
      `  Courses: ${show(src.courseCount)}`,
      `  Categories: ${show(src.categoryCount)}`,
      `  Reduction constant across courses: ${show(src.reductionConstant)}`,
      `  An active course was present: ${show(src.hasActiveCourse)}`,
      '',
      'Settings',
      `  Max booster cooldown (hours): ${show(settings && settings.maxCooldownHours)}`,
      `  Books owned: ${show(settings && settings.booksOwned)}`,
      `  Book price: ${show(settings && settings.bookPrice)}`,
      `  Job points: ${show(settings && settings.jobPoints)}`,
      `  Merits reduction (%): ${show(perks.meritsPercent)}`,
      `  Principal rank: ${show(perks.principal)}`,
      `  WSU stock block: ${show(perks.wsuBlock)}`,
      `  Queue order: ${show(settings && settings.orderMode)}`,
      '',
      'Queue',
      `  Length: ${show(src.queueLength)}`,
      // Joined with a space, not a comma, so no run of ids can be mistaken
      // for the completed-course set this report deliberately withholds.
      `  Courses: ${Array.isArray(src.queueCodes) && src.queueCodes.length > 0 ? src.queueCodes.join(' ') : 'none'}`,
      '',
      // GREASY_FORK_URL's one consumer. Named in prose either way, because
      // the instruction is useful without the URL; the URL is appended only
      // once it exists, so resolving it has a visible effect here and a test
      // that fails if it is set without the report being re-checked.
      GREASY_FORK_URL
        ? `Please paste this into the feedback area on the Greasy Fork page for this script: ${GREASY_FORK_URL}`
        : 'Please paste this into the feedback area on the Greasy Fork page for this script.',
    ];
    return lines.join('\n');
  }

  const SHARE_PREFIX = 'TES1';

  // A flat, version-prefixed, pipe-delimited string rather than base64 JSON.
  // Two reasons: base64 would mean btoa, a host global the engine may not
  // touch; and a format with no encoder and no escape sequences cannot be
  // evaluated as code by any reader, which is the security property this needs
  // — achieved structurally rather than by discipline.
  function encodePlan(plan, settings) {
    const queue = (plan && Array.isArray(plan.queue)) ? plan.queue.filter(isInt) : [];
    const s = normaliseSettings(settings);
    const parts = [
      SHARE_PREFIX,
      `q=${queue.join(',')}`,
      `c=${s.maxCooldownHours}`,
      `b=${s.booksOwned}`,
      `p=${s.bookPrice}`,
      `j=${s.jobPoints}`,
      `o=${s.orderMode}`,
    ];
    if (s.perks.meritsPercent !== null) parts.push(`m=${s.perks.meritsPercent}`);
    if (s.perks.principal !== null) parts.push(`pr=${s.perks.principal ? 1 : 0}`);
    if (s.perks.wsuBlock !== null) parts.push(`w=${s.perks.wsuBlock ? 1 : 0}`);
    return parts.join('|');
  }

  // The one piece of the share string that is quoted back to the player, so it
  // is the one piece that needs sizing and sanitising. gatherDebugContext
  // already clamps Torn's own `raw.error` on the reasoning that "that string is
  // not ours to size" — and a pasted share string comes from a more hostile
  // source than Torn does. 40 characters is enough to find the offending token
  // in a paste and not enough to be a wall of text.
  //
  // The character replacement is the other half, and it is not decoration: a
  // bidi override (U+202E) inside the quoted token reverses the display of the
  // rest of the line it lands in, so an "error" message can be made to read as
  // something else entirely. Every one of these is invisible by definition,
  // which means removing them costs the player nothing — they could not have
  // seen the character in their paste either way.
  const MAX_TOKEN_CHARS = 40;
  const UNPRINTABLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;
  function quoteToken(token) {
    const safe = token.replace(UNPRINTABLE, '\uFFFD');
    return safe.length <= MAX_TOKEN_CHARS
      ? `"${safe}"`
      : `"${safe.slice(0, MAX_TOKEN_CHARS)}…" (truncated, ${safe.length} chars)`;
  }

  // Untrusted input, treated as such: every id is checked against the live
  // catalogue and an unknown one is rejected by name, unrecognised keys are
  // ignored, and the field bag is a null-prototype object so a key like
  // __proto__ in the string is data rather than an assignment.
  //
  // This is the only thing in the script that parses text from outside the
  // player's own browser, so the one contract it must not break is that it
  // never throws on any string: a throw here reaches init()'s catch and blanks
  // the panel, which is a worse outcome than any rejection it could return
  // instead. The catalogue is the caller's, not the string's, and the guard
  // below covers every shape the one call site can produce — but a Map-like
  // whose own `has` throws is still the caller's bug and is not caught here.
  function decodePlan(text, courses) {
    if (typeof text !== 'string') return { ok: false, reason: 'bad-prefix', detail: 'not a string' };
    const trimmed = text.trim();
    const parts = trimmed.split('|');
    if (parts[0] !== SHARE_PREFIX) {
      return { ok: false, reason: 'bad-prefix', detail: `expected a string starting ${SHARE_PREFIX}|` };
    }

    const fields = Object.create(null);
    for (let i = 1; i < parts.length; i += 1) {
      const eq = parts[i].indexOf('=');
      if (eq <= 0) continue;
      fields[parts[i].slice(0, eq)] = parts[i].slice(eq + 1);
    }

    // A catalogue that is absent, or is not one, must reject rather than
    // throw: `courses.has` on a plain object is a TypeError, and the
    // never-throws contract above is not conditional on the caller.
    const catalogue = (courses && typeof courses.has === 'function') ? courses : null;
    const queue = [];
    const seen = new Set();
    const rawQueue = typeof fields.q === 'string' ? fields.q : '';
    if (rawQueue.length > 0) {
      for (const token of rawQueue.split(',')) {
        if (!/^\d+$/.test(token)) {
          return { ok: false, reason: 'bad-course-id', detail: `${quoteToken(token)} is not a course id` };
        }
        const id = Number(token);
        if (!catalogue || !catalogue.has(id)) {
          return { ok: false, reason: 'unknown-course', detail: `course ${id} is not in the catalogue` };
        }
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push(id);
      }
    }

    // normaliseSettings is the only writer of the canonical shape, so every
    // hostile or nonsensical value below falls back to its default.
    const toInt = function (v) { return /^-?\d+$/.test(v || '') ? Number(v) : undefined; };
    const toBool = function (v) { return v === '1' ? true : v === '0' ? false : undefined; };
    const settings = normaliseSettings({
      maxCooldownHours: toInt(fields.c),
      booksOwned: toInt(fields.b),
      bookPrice: toInt(fields.p),
      jobPoints: toInt(fields.j),
      orderMode: fields.o,
      perks: {
        meritsPercent: toInt(fields.m),
        principal: toBool(fields.pr),
        wsuBlock: toBool(fields.w),
      },
    });

    return { ok: true, queue: queue, settings: settings };
  }

  // ─── ENGINE END ─────────────────────────────────────────────────

  // ─── RUNTIME ────────────────────────────────────────────────────

  // Returns a fresh object each call — a shared mutable default would let one
  // caller's edits leak into another's "empty" plan.
  function freshPlan() {
    return { queue: [], collapsed: false };
  }

  // GM storage rather than localStorage: a plan can represent months of intent,
  // so it should survive a site-data clear and stay unreadable by torn.com's
  // own page scripts.
  function loadPlan() {
    let stored;
    try {
      stored = GM_getValue(STORAGE_KEY, null);
    } catch (e) {
      return freshPlan();
    }
    if (typeof stored !== 'string') return freshPlan();

    let parsed;
    try {
      parsed = JSON.parse(stored);
    } catch (e) {
      return freshPlan();
    }
    if (!parsed || !Array.isArray(parsed.queue)) return freshPlan();

    const seen = new Set();
    const queue = [];
    for (const id of parsed.queue) {
      if (!Number.isInteger(id) || seen.has(id)) continue;
      seen.add(id);
      queue.push(id);
    }

    return {
      queue: queue,
      collapsed: parsed.collapsed === true,
    };
  }

  // Returns true on success, false on failure, so the caller can tell the
  // player their edit did not persist instead of losing it silently.
  function savePlan(plan) {
    try {
      GM_setValue(STORAGE_KEY, JSON.stringify({
        queue: (plan.queue || []).filter(function (id) { return Number.isInteger(id); }),
        collapsed: plan.collapsed === true,
      }));
      return true;
    } catch (e) {
      // Storage failure must not take the panel down with it.
      return false;
    }
  }

  function freshSettings() { return normaliseSettings(null); }

  // Deliberately a second key. A corrupt settings blob must not be able to
  // cost the player their queue, and the two have unrelated lifetimes.
  function loadSettings() {
    let stored;
    try { stored = GM_getValue(SETTINGS_KEY, null); } catch (e) { return freshSettings(); }
    if (stored === null || stored === undefined) return freshSettings();
    let parsed = stored;
    if (typeof stored === 'string') {
      try { parsed = JSON.parse(stored); } catch (e) { return freshSettings(); }
    }
    return normaliseSettings(parsed);
  }

  // Returns true/false exactly as savePlan does, so the caller can report a
  // write that did not land instead of losing the edit silently.
  function saveSettings(settings) {
    try {
      GM_setValue(SETTINGS_KEY, JSON.stringify(normaliseSettings(settings)));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Same-origin, so the session cookie rides along and no @connect is needed.
  // Always resolves: the panel must be able to say what went wrong, and a
  // rejected promise here would surface as a blank panel instead.
  //
  // Torn rejects this endpoint without an rfcv anti-CSRF query parameter, so a
  // token is required before any request goes out. When cookieString is not
  // supplied, the ambient cookie jar is read here (RUNTIME, not the engine) —
  // guarded so a realm with no such global cannot throw.
  async function fetchEducationData(fetchImpl, cookieString) {
    let cookies = cookieString;
    if (typeof cookies !== 'string') {
      try {
        cookies = (typeof document !== 'undefined' && typeof document.cookie === 'string') ? document.cookie : '';
      } catch (e) {
        cookies = '';
      }
    }

    const token = readRfcvToken(cookies);
    if (!token) {
      // Firing the request anyway is guaranteed to fail (Torn returns 200
      // with success:false), so stop here instead of burning a round trip.
      // The reason string does not carry the token, only its absence.
      return { ok: false, reason: 'no-session-token', detail: 'could not read your Torn session token — try reloading the page' };
    }

    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return { ok: false, reason: 'network', detail: 'no fetch available' };

    // rfcv is a session-scoped anti-CSRF credential — it belongs on the URL
    // sent to Torn and nowhere else. It must never reach a detail string, a
    // rendered panel, or storage.
    const url = `${EDU_ENDPOINT}&rfcv=${encodeURIComponent(token)}`;

    let response;
    try {
      response = await doFetch(url, {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
    } catch (e) {
      return { ok: false, reason: 'network', detail: String(e && e.message ? e.message : e) };
    }

    if (!response) return { ok: false, reason: 'network', detail: 'empty response' };
    if (!response.ok) return { ok: false, reason: 'http', detail: `status ${response.status}` };

    let text;
    try {
      text = await response.text();
    } catch (e) {
      return { ok: false, reason: 'network', detail: 'could not read response body' };
    }

    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      // Never echo the response body. When Torn serves an HTML page here it is
      // a logged-out or error page, and this repo has already found userID,
      // logoutHash and a signed JWT inline in that markup. The size and type
      // are enough to diagnose; the bytes are not ours to put on screen.
      const shape = typeof text === 'string' ? `${text.length} bytes of non-JSON` : `a ${typeof text}`;
      return { ok: false, reason: 'not-json', detail: `response was ${shape}` };
    }

    try {
      return { ok: true, data: parsePayload(raw) };
    } catch (e) {
      return { ok: false, reason: (e && e.reason) || 'not-a-payload', detail: (e && e.message) || 'unknown parser failure' };
    }
  }

  // React attaches its internals to DOM nodes under a key whose suffix is a
  // per-build random number — match the stable prefix only, exactly as every
  // class selector in this file does.
  const FIBER_KEY_PREFIXES = ['__reactFiber$', '__reactProps$', '__reactInternalInstance$'];
  // maxNodes is the binding limit; maxDepth is close to decorative. A FiberNode
  // carries roughly 15-20 object-valued own properties, so a breadth-first walk
  // spends 20,000 nodes somewhere around depth 3-4 and never approaches 14. The
  // real reach of path 2 is about four hops from a fiber root. If the manual-QA
  // pass finds the payload sitting further out than that, raise maxNodes —
  // raising maxDepth on its own will do nothing.
  const FIBER_LIMITS = { maxNodes: 20000, maxDepth: 14 };
  // React 18 hangs both __reactFiber$ and __reactProps$ on every host node, so
  // a swept page yields roots in pairs. They point into one graph, and the
  // shared walk state dedupes the overlap, but collecting hundreds of entry
  // points is still pointless: cap the list.
  const FIBER_MAX_ROOTS = 8;
  // The nodes most likely to carry the education props, cheapest first. Falls
  // back, when none match, to the first 200 `div`s document-wide
  // (fiberRootsFrom's `doc.querySelectorAll('div')`) — document-wide and
  // `div`-only, not a sweep of the body's element children, so a non-`div`
  // body child is never sampled by the fallback.
  const FIBER_HOST_SELECTORS = [
    '[class*="educationPage___"]',
    '#react-root',
    '[class*="content-wrapper"]',
    '#mainContainer',
  ];

  function fiberRootsFrom(doc) {
    const roots = [];
    if (!doc || typeof doc.querySelector !== 'function') return roots;

    const nodes = [];
    for (const selector of FIBER_HOST_SELECTORS) {
      let el = null;
      try { el = doc.querySelector(selector); } catch (e) { el = null; }
      if (el) nodes.push(el);
    }
    if (nodes.length === 0 && typeof doc.querySelectorAll === 'function') {
      let all = [];
      try { all = doc.querySelectorAll('div'); } catch (e) { all = []; }
      // A page can hold thousands of divs; sample the first 200 rather than
      // scraping keys off every one of them.
      for (let i = 0; i < all.length && i < 200; i += 1) nodes.push(all[i]);
    }

    // Identity-deduped and capped. The sweep above can offer up to 200 nodes,
    // each carrying two or more React keys; without this the walk would be
    // handed hundreds of entry points into the same graph.
    const seenRoots = new Set();
    for (const node of nodes) {
      if (roots.length >= FIBER_MAX_ROOTS) break;
      let keys;
      try { keys = Object.keys(node); } catch (e) { continue; }
      for (const key of keys) {
        for (const prefix of FIBER_KEY_PREFIXES) {
          if (key.indexOf(prefix) === 0) {
            let value;
            try { value = node[key]; } catch (e) { value = null; }
            if (value && typeof value === 'object' && !seenRoots.has(value)) {
              seenRoots.add(value);
              roots.push(value);
              if (roots.length >= FIBER_MAX_ROOTS) return roots;
            }
          }
        }
      }
    }
    return roots;
  }

  // Contracted never to reject, exactly as fetchEducationData is: init() has
  // no catch around acquisition and a rejection here blanks the panel.
  async function readFiberEducationData(doc) {
    try {
      const roots = fiberRootsFrom(doc);
      if (roots.length === 0) return { ok: false, reason: 'no-fiber', detail: 'no React internals found on the page' };
      // One budget for the whole search, not one per root — see newWalkState.
      const walk = newWalkState();
      for (const root of roots) {
        const raw = searchForPayload(root, FIBER_LIMITS, walk);
        if (raw) {
          try {
            return { ok: true, data: parsePayload(raw), source: 'fiber' };
          } catch (e) {
            return { ok: false, reason: (e && e.reason) || 'bad-fiber-payload', detail: (e && e.message) || 'unparseable' };
          }
        }
        if (walk.exhausted) break;
      }
      // "Ran out of budget" is not "was not there", and saying the second when
      // the first happened would misdirect anyone reading a debug report.
      if (walk.exhausted) {
        return {
          ok: false,
          reason: 'fiber-budget-exhausted',
          detail: `gave up after ${walk.visited} nodes without finding the education payload`,
        };
      }
      return { ok: false, reason: 'no-fiber-payload', detail: 'React internals held no education payload' };
    } catch (e) {
      return { ok: false, reason: 'fiber-threw', detail: (e && e.message) || String(e) };
    }
  }

  // A chain, not a race: the endpoint is the source of truth and the fiber is
  // only consulted when it fails, so a stale React tree can never quietly win
  // against a good response.
  //
  // The outer try is defensive rather than expected to fire: both callees are
  // themselves contracted never to reject. But this is the function init()
  // awaits with no catch of its own, so a rejection escaping here blanks the
  // panel — the one failure mode the whole error path exists to prevent. It
  // also covers the string interpolation below, which reads fields off values
  // this function did not construct.
  async function acquireEducationData(doc) {
    try {
      const fetched = await fetchEducationData(null);
      if (fetched && fetched.ok) return { ok: true, data: fetched.data, source: 'fetch' };

      const fiber = await readFiberEducationData(doc);
      if (fiber && fiber.ok) return { ok: true, data: fiber.data, source: 'fiber' };

      return {
        ok: false,
        reason: (fetched && fetched.reason) || 'acquire-failed',
        detail: `${(fetched && fetched.detail) || 'the endpoint failed'} (page fallback also failed: ${(fiber && fiber.reason) || 'unknown'})`,
        triedFiber: true,
      };
    } catch (e) {
      return {
        ok: false,
        reason: 'acquire-threw',
        detail: (e && e.message) || String(e),
        triedFiber: true,
      };
    }
  }

  function isEducationPage() {
    return typeof location !== 'undefined'
      && location.pathname === '/page.php'
      && /(\?|&)sid=education(&|$)/.test(location.search || '');
  }

  function formatTimestamp(seconds) {
    return new Date(seconds * 1000).toUTCString().replace(/GMT$/, 'UTC');
  }

  function formatDuration(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const parts = [];
    if (days > 0) parts.push(days === 1 ? '1 day' : `${days} days`);
    if (hours > 0) parts.push(hours === 1 ? '1 hour' : `${hours} hours`);
    if (parts.length === 0) return '0 hours';
    return parts.join(' ');
  }

  // Same distinction inferPerks draws, for the same reason: "varies by course"
  // states something about the player's account, so it needs two real ratios
  // behind it. Anything else we simply could not read — and a NaN ratio must
  // never surface as "NaN% off".
  function reductionLabel(reduction) {
    if (!reduction || typeof reduction !== 'object') return 'could not be read';
    if (reduction.constant !== true || !Number.isFinite(reduction.ratio)) {
      const realRatios = Array.isArray(reduction.ratios) ? reduction.ratios.filter(function (r) { return Number.isFinite(r); }) : [];
      return realRatios.length >= 2 ? 'varies by course' : 'could not be read';
    }
    return `${Math.round((1 - reduction.ratio) * 100)}% off`;
  }

  // The settings view reads every field off model.settings unconditionally, so
  // the model owes it a complete shape rather than a null. normaliseSettings is
  // the only writer of that shape, and it turns anything — including undefined —
  // into the documented defaults, so it is also the right way to supply one.
  function panelSettings(state) {
    return normaliseSettings(state.settings);
  }

  // No data means nothing to infer from; the note still has to say something,
  // because the field group is rendered either way.
  const NO_INFERENCE = {
    determinate: false,
    totalPercent: null,
    note: 'Your education data could not be read, so no perks can be inferred. Enter what you hold.',
  };

  // In words, from focusTotals' shape. `unit: 'count'` never states a
  // percentage — the whole reason FOCUS_UNSTATABLE and the Unlocks &
  // Abilities category are folded into 'count' rather than left to show a
  // magnitude nobody can stand behind.
  function focusRemainingLabel(totals) {
    if (totals.remaining <= 0) return 'complete';
    if (totals.unit === 'percent') return `${totals.remaining}% left of ${totals.total}%`;
    if (totals.unit === 'flat') return `${totals.remaining} left of ${totals.total}`;
    return totals.statable
      ? `${totals.remaining} of ${totals.total} left`
      : `${totals.remaining} course${totals.remaining === 1 ? '' : 's'} left, no fixed total`;
  }

  function buildPanelModel(state) {
    // Computed once, here, so nothing downstream depends on the caller having
    // normalised: panelSettings runs normaliseSettings, which turns anything —
    // including undefined — into the documented defaults.
    const settings = panelSettings(state);
    const empty = {
      status: 'error', message: null, reductionLabel: null,
      queue: [], addable: [], stale: [], problems: [], finishLabel: null, totalLabel: null,
      collapsed: state.plan.collapsed === true,
      saveError: state.saveFailed === true,
      selectedCourseId: state.selectedCourseId != null ? state.selectedCourseId : null,
      view: state.view || 'schedule',
      settings: settings,
      settingsSaveError: state.settingsSaveFailed === true,
      perkInference: NO_INFERENCE,
      // No payload means no total to reduce, so there is no floor date to
      // quote — and a floor date is the one thing that must never be guessed.
      consumables: null,
      orderModes: ORDER_MODE_LABELS,
      // Null until the player asks for it. An acquisition failure is exactly
      // when the report is most wanted — and it is genuinely reachable from
      // here: renderPanel no longer returns before the nav row on an error
      // model, so the settings view (which owns the report) can be opened.
      // This is the only path on which failureReason/failureDetail are
      // populated at all, so if it stops being reachable the report's whole
      // Failure block silently becomes "not recorded".
      debugReport: state.debugReport || null,
      // There is no payload to derive degrees from, so the grid view says so
      // rather than drawing thirteen empty boxes.
      grid: null,
      // Same reasoning as grid: no catalogue means no totals to state and no
      // registry to check for staleness, so the focus view says so rather
      // than drawing empty categories.
      focusGroups: null,
      focuses: null,
      focusHealth: null,
      // Nothing to share: without a catalogue there is no queue this model can
      // vouch for, and a share string is a claim about a plan. Empty rather
      // than null, because the box renders either way and `null` in a textarea
      // is the string "null".
      shareText: '',
      importError: state.importError || null,
    };

    if (!state.fetchResult.ok) {
      empty.message = `Couldn't load your education data (${state.fetchResult.reason}: ${state.fetchResult.detail}).`;
      return empty;
    }

    const data = state.fetchResult.data;
    // A stored plan outlives the state it was written against. Two things can
    // rot: a course can leave the game, and — far more likely — a queued course
    // can be finished in-game between sessions. A completed course is not work
    // remaining, so counting its weeks would push the finish date out by time
    // the player has already served. Drop both, and say so rather than
    // silently editing the player's plan.
    const stale = [];
    const prunedQueue = state.plan.queue.filter(function (id) {
      const course = data.courses.get(id);
      if (!course) { stale.push({ courseId: id, why: 'no longer in the catalogue' }); return false; }
      if (course.status === 'completed') { stale.push({ courseId: id, prefix: course.prefix, why: 'already completed' }); return false; }
      if (course.status === 'inProgress') { stale.push({ courseId: id, prefix: course.prefix, why: 'currently in progress' }); return false; }
      return true;
    });
    // The player's chosen ordering is applied once, here, and everything
    // downstream — schedule, validateQueue, finishById, the rendered rows —
    // reads the ordered queue. It cannot move the finish date (a sum does not
    // care about order); it moves which course finishes when, which is the
    // whole point of offering the choice.
    const queue = orderQueue(prunedQueue, settings.orderMode, data.courses);
    const result = schedule({
      courses: data.courses, activeCourse: data.activeCourse, queue: queue, now: state.now,
    });

    const finishById = new Map(result.items.map(function (i) { return [i.courseId, i.finishesAt]; }));

    // Judged against what the player will have finished when the queue starts,
    // not against today: the active course completes first (schedule() begins
    // the queue at activeCourse.completedAt), so a course gated on it is
    // followable and must not be reported as a missing prerequisite. Reporting
    // it would withhold the finish date — the number this tool exists for —
    // from a plan the player can actually follow.
    const plannedDone = plannedCompletions(data.completedIds, data.courses, data.activeCourse);
    const problems = validateQueue(queue, plannedDone, data.courses).map(function (problem) {
      return {
        courseId: problem.courseId,
        prefix: data.courses.get(problem.courseId).prefix,
        missing: problem.missing.map(function (id) {
          const course = data.courses.get(id);
          return { id: id, prefix: course ? course.prefix : 'unknown' };
        }),
      };
    });

    const queued = new Set(queue);
    const addable = [];
    for (const course of data.courses.values()) {
      if (course.status === 'completed' || course.status === 'inProgress') continue;
      if (queued.has(course.id)) continue;
      // Tier-3 courses unlock things and gate on an entire degree, so they have
      // to stand out among ~115 entries. Styling an <option> is unreliable
      // across browsers; a text marker in the label is the portable answer.
      const isBachelor = course.tier === 3;
      addable.push({
        courseId: course.id,
        prefix: course.prefix,
        name: course.name,
        isBachelor: isBachelor,
        durationLabel: formatDuration(course.duration),
        label: `${isBachelor ? '[bachelor] ' : ''}${course.prefix} ${course.name} (${formatDuration(course.duration)})`,
      });
    }
    addable.sort(function (a, b) { return a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0; });

    // Never present a guess as a reading. The note says in words which of the
    // two situations the player is in, so a prefilled field is visibly an
    // inference they are invited to correct rather than a value we read off
    // their account.
    // The grid is independent of the player's queue: each box starts from now
    // and answers its own question. Labels are built here rather than in the
    // view, because formatDuration/formatTimestamp are runtime while
    // buildDegreeGrid is engine.
    const rawGrid = buildDegreeGrid({
      courses: data.courses, categories: data.categories, completedIds: data.completedIds,
      activeCourse: data.activeCourse, now: state.now,
    });
    const grid = {
      sumsDiffer: rawGrid.sumsDiffer,
      boxes: rawGrid.boxes.map(function (b) {
        return {
          key: b.key, name: b.name, bachelorPrefix: b.bachelorPrefix,
          courseCount: b.courseCount, totalSeconds: b.totalSeconds, finishesAt: b.finishesAt,
          durationLabel: formatDuration(b.totalSeconds),
          finishLabel: formatTimestamp(b.finishesAt),
        };
      }),
    };

    // The registry drives both what the focus view can offer and what it is
    // honest about not knowing: a stale row lost its outcome match, an
    // unmapped outcome has no row at all. Reported as counts only — never
    // which course, which is what would make this a second copy of the
    // taxonomy the view is not meant to be.
    const focusReg = focusRegistry(data.courses);
    const focusHealth = { stale: focusReg.stale, unmapped: focusReg.unmapped };

    // Priority is settings.focuses' own array index, never a stored number —
    // see toggleFocus/setFocusPriority. An unchosen selection gets null here,
    // never 0: a number nobody set must not read as a number somebody set.
    const focusPriorityByKey = new Map();
    settings.focuses.forEach(function (f, i) { focusPriorityByKey.set(focusKey(f.category, f.selection), i + 1); });

    const focusGroups = FOCUS_CATEGORIES.map(function (category) {
      let selections;
      if (category === FOCUS_WORKING_STATS) {
        selections = WORKING_STATS.slice();
      } else {
        // First occurrence per selection: a selection can be reached by more
        // than one taxonomy row (a split course), and the view offers it once.
        const seen = new Set();
        selections = [];
        for (const row of FOCUS_TAXONOMY) {
          if (row.category !== category || seen.has(row.selection)) continue;
          seen.add(row.selection);
          selections.push(row.selection);
        }
      }
      return {
        category: category,
        selections: selections.map(function (selection) {
          const totals = focusTotals({ category: category, selection: selection }, data.courses, data.completedIds);
          const key = focusKey(category, selection);
          return {
            selection: selection,
            unit: totals.unit,
            total: totals.total,
            remaining: totals.remaining,
            statable: totals.statable,
            remainingLabel: focusRemainingLabel(totals),
            priority: focusPriorityByKey.has(key) ? focusPriorityByKey.get(key) : null,
          };
        }),
      };
    });

    // Same gate as finishLabel/totalLabel below, and for the same reason: a
    // queue with unmet prerequisites has no honest total, so it has nothing for
    // Books to reduce either. Reducing a fiction would produce a floor date
    // that is wrong twice over.
    //
    // Both figures come off the queue's own seconds. The floor is derived from
    // the ceiling directly — never from the planned date minus leftovers — so
    // it does not move when the player edits how many Books they own.
    const consumables = (queue.length > 0 && problems.length === 0)
      ? planConsumables({
          baseSeconds: result.totalSeconds,
          maxCooldownSeconds: settings.maxCooldownHours * 3600,
          booksOwned: settings.booksOwned,
          bookPrice: settings.bookPrice,
        })
      : null;
    // startsAt + seconds, not finishesAt - saving: the queue begins when the
    // active course ends, and that anchor is the only fixed point either date
    // can be measured from.
    const consumablesModel = consumables ? {
      ceiling: consumables.ceiling,
      plannedBooks: consumables.plannedBooks,
      plannedFinishLabel: formatTimestamp(result.startsAt + consumables.plannedSeconds),
      plannedDurationLabel: formatDuration(consumables.plannedSeconds),
      floorBooks: consumables.floorBooks,
      floorFinishLabel: formatTimestamp(result.startsAt + consumables.floorSeconds),
      floorDurationLabel: formatDuration(consumables.floorSeconds),
      // Withheld rather than rendered as "$0" when no price is set. The rule
      // this feature turns on is that the floor date never appears without its
      // cost — and "$0" satisfies the letter of that while defeating its whole
      // purpose, because it tells the player the floor is free.
      //
      // One field, not a label plus a known-flag: formatMoney never returns a
      // falsy string, so null IS the absence, and the view tests the label it
      // is about to print. A separate flag is a second copy of one fact, and
      // the failure it invites is an edit that sets the label without the flag
      // and renders the string "null" into the panel. This is the shape
      // finishLabel already uses, for the same reason.
      floorCostLabel: consumables.priceKnown ? formatMoney(consumables.floorCost) : null,
    } : null;

    const inference = inferPerks(data.reduction);
    const perkInference = {
      determinate: inference.determinate,
      totalPercent: inference.totalPercent,
      note: inference.determinate
        ? `Inferred from your ${inference.totalPercent}% reduction: this total has only one possible combination. Correct it if it is wrong. The reduction itself is read from Torn, not reconstructed from these fields — they only travel with a shared plan or a debug report.`
        : inference.reason === 'varies'
          ? 'Your reduction varies by course, so no perk combination can be read from it. Enter what you hold.'
          // Not "your reduction varies": we failed to read it, and saying
          // otherwise would state something about their account we have no
          // evidence for.
          : inference.reason === 'unreadable'
            ? 'Your time reduction could not be read from this page, so no perk combination can be inferred. Enter what you hold.'
            : inference.reason === 'unrecognised'
              ? `Your ${inference.totalPercent}% reduction does not match any combination of the three known perks. Enter what you hold.`
              : `Your ${inference.totalPercent}% reduction has ${inference.candidates} possible combinations, so it cannot be read. Enter what you hold.`,
    };

    return {
      status: 'ok',
      message: null,
      reductionLabel: reductionLabel(data.reduction),
      addable: addable,
      stale: stale,
      queue: queue.map(function (id) {
        const course = data.courses.get(id);
        return {
          courseId: id,
          prefix: course.prefix,
          name: course.name,
          duration: course.duration,
          durationLabel: formatDuration(course.duration),
          finishesAt: finishById.get(id),
          finishLabel: formatTimestamp(finishById.get(id)),
        };
      }),
      problems: problems,
      // A wrong date stated confidently is worse than no date at all. When the
      // queue has unmet prerequisites it is not a plan the player can actually
      // follow in order, so schedule()'s sum describes a fiction — withhold it
      // rather than print it. The problems list itself (rendered above) already
      // names what is missing.
      finishLabel: (queue.length > 0 && problems.length === 0) ? formatTimestamp(result.finishesAt) : null,
      totalLabel: (queue.length > 0 && problems.length === 0) ? formatDuration(result.totalSeconds) : null,
      collapsed: state.plan.collapsed === true,
      saveError: state.saveFailed === true,
      selectedCourseId: state.selectedCourseId != null ? state.selectedCourseId : null,
      view: state.view || 'schedule',
      settings: settings,
      settingsSaveError: state.settingsSaveFailed === true,
      perkInference: perkInference,
      consumables: consumablesModel,
      orderModes: ORDER_MODE_LABELS,
      debugReport: state.debugReport || null,
      grid: grid,
      focusGroups: focusGroups,
      focuses: settings.focuses,
      focusHealth: focusHealth,
      // Built from the pruned queue, in storage order — never the ordered
      // queue: ordering is a display preference, and storage keeps the raw
      // order. Sharing the ordered queue would silently rewrite a hand-built
      // order to whatever the current orderMode produces on the next import,
      // with no bulk undo.
      shareText: encodePlan({ queue: prunedQueue }, settings),
      importError: state.importError || null,
    };
  }

  // Every field here is named explicitly. Adding a field to the report means
  // adding it here and to buildDebugReport, which is the point — nothing
  // reaches the report by being present on some object that got passed along.
  //
  // GM_info is read through a typeof guard and is deliberately NOT added to
  // @grant: it is ambient in every manager, and a grant would widen the
  // security surface for a diagnostic nicety. Absent, the report says so.
  // navigator gets the same guard — it does not exist in the test sandbox,
  // and an unguarded reference is a ReferenceError that blanks the panel.
  // The same guard course.prefix gets, for the same reason. Every realistic
  // producer of a reason/detail hands us a string, but the catch blocks build
  // theirs from `(e && e.message)` — and a thrown value is whatever threw it.
  // A non-string is dropped rather than coerced, so nothing reaches String()
  // that could carry a toString we did not write.
  //
  // The bound is on the detail because parsePayload splices Torn's own
  // `raw.error` into it whole, and that string is not ours to size. The report
  // is pasted in public by hand; an unbounded server message in it is a wall
  // of text at best. Truncation is marked, so nothing disappears silently.
  const MAX_DETAIL_CHARS = 300;
  function debugText(v, limit) {
    if (typeof v !== 'string') return null;
    if (!limit || v.length <= limit) return v;
    return `${v.slice(0, limit)}… (truncated, ${v.length} chars total)`;
  }

  function gatherDebugContext(state) {
    const nav = (typeof navigator !== 'undefined') ? navigator : null;
    const data = (state.fetchResult && state.fetchResult.ok) ? state.fetchResult.data : null;
    const queue = (state.plan && Array.isArray(state.plan.queue)) ? state.plan.queue : [];
    return {
      scriptVersion: SCRIPT_VERSION,
      userAgent: nav && typeof nav.userAgent === 'string' ? nav.userAgent : null,
      manager: (typeof GM_info !== 'undefined' && GM_info && GM_info.scriptHandler)
        ? `${GM_info.scriptHandler} ${GM_info.version || ''}`.trim()
        : null,
      failureReason: state.fetchResult && !state.fetchResult.ok ? debugText(state.fetchResult.reason) : null,
      failureDetail: state.fetchResult && !state.fetchResult.ok ? debugText(state.fetchResult.detail, MAX_DETAIL_CHARS) : null,
      source: state.fetchResult && state.fetchResult.ok ? debugText(state.fetchResult.source) : null,
      courseCount: data ? data.courses.size : null,
      categoryCount: data ? data.categories.length : null,
      reductionConstant: data ? data.reduction.constant : null,
      hasActiveCourse: data ? data.activeCourse !== null : null,
      queueLength: queue.length,
      // prefix is the one payload-derived string that reaches the report, and
      // normaliseCourse copies it across without a type check. Requiring a
      // real string here (rather than letting join() call toString on
      // whatever Torn sent) is what makes the allowlist airtight end to end.
      queueCodes: data ? queue.map(function (id) {
        const c = data.courses.get(id);
        return (c && typeof c.prefix === 'string') ? c.prefix : String(id);
      }) : [],
      settings: state.settings || null,
    };
  }

  // Torn's class names are CSS-module hashes whose suffix changes on every
  // frontend rebuild, so every selector matches the stable prefix only.
  const MOUNT_SELECTORS = [
    '[class*="educationPage___"]',
    '[class*="content-wrapper"]',
    '#mainContainer',
  ];

  function findMountPoint(doc) {
    for (const selector of MOUNT_SELECTORS) {
      const el = doc.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  // Injected once and left alone across redraws: the panel itself is torn
  // down and rebuilt on every draw (see the #tes-panel removal below), but a
  // <style> tag has no reason to churn with it, and re-appending on every
  // draw would grow an unbounded pile of identical <style> tags over a
  // session.
  // Every render-path lookup against the host document goes through here.
  // findMountPoint is deliberately not one of them: its throw is the signal
  // init() turns into a named visible error. Everywhere else a document that
  // throws on querySelector must degrade to "not found" rather than take the
  // render down with it — the render is the only thing that can tell the user
  // anything at all.
  function queryOne(doc, selector) {
    try { return doc.querySelector(selector); } catch (e) { return null; }
  }

  function injectStyleOnce(doc) {
    if (queryOne(doc, '#tes-style')) return;
    const style = doc.createElement('style');
    style.id = 'tes-style';
    style.textContent = [
      '#tes-panel { border: 1px solid #4a4a4a; background: #1c1c1c; color: #e6e6e6;',
      '  padding: 12px 14px; margin: 12px 0; border-radius: 6px; font-size: 13px; line-height: 1.5; }',
      '#tes-panel .tes-header { font-weight: bold; cursor: pointer; margin-bottom: 8px; }',
      '#tes-panel .tes-nav { display: flex; gap: 6px; margin-bottom: 8px; }',
      '#tes-panel .tes-finish { font-size: 1.25em; font-weight: bold; color: #7ee081; margin-bottom: 8px; }',
      '#tes-panel .tes-save-error { color: #ff8080; font-weight: bold; margin-bottom: 8px; }',
      '#tes-panel .tes-error { color: #ff8080; margin-bottom: 8px; }',
      '#tes-panel .tes-summary { white-space: pre-line; margin-bottom: 8px; }',
      '#tes-panel .tes-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0; }',
      '#tes-panel button, #tes-panel select { color: #e6e6e6; background: #2e2e2e; border: 1px solid #4a4a4a;',
      '  border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: inherit; }',
      '#tes-panel button:hover { border-color: #7ee081; }',
      '#tes-panel .tes-section { margin-bottom: 10px; }',
      '#tes-panel .tes-section-title { font-weight: bold; margin-bottom: 4px; opacity: 0.85; }',
      '#tes-panel .tes-note { opacity: 0.75; margin-bottom: 6px; }',
      '#tes-panel input { color: #e6e6e6; background: #2e2e2e; border: 1px solid #4a4a4a;',
      '  border-radius: 4px; padding: 3px 6px; font-size: inherit; width: 10em; }',
      // The report is shown before it can be copied, so it needs to be
      // readable in place: wrapped, scrollable, and visibly a block of text
      // the player is about to hand to someone else.
      '#tes-panel .tes-report { white-space: pre-wrap; word-break: break-word; background: #111;',
      '  border: 1px solid #4a4a4a; border-radius: 4px; padding: 8px; margin: 8px 0; max-height: 240px; overflow: auto; }',
      // auto-fill rather than a fixed column count: the panel sits inside
      // Torn's own column, whose width the script does not control.
      '#tes-panel .tes-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; margin: 8px 0; }',
      '#tes-panel .tes-cell { border: 1px solid #4a4a4a; border-radius: 4px; padding: 8px; }',
      '#tes-panel .tes-cell-all { border-color: #7ee081; }',
      '#tes-panel .tes-cell-title { font-weight: bold; margin-bottom: 4px; }',
      // pre-line, because the detail carries a newline between the duration
      // and the finish date rather than two elements.
      '#tes-panel .tes-cell-detail { white-space: pre-line; opacity: 0.85; }',
      '#tes-panel .tes-share { width: 100%; box-sizing: border-box; color: #e6e6e6; background: #2e2e2e;',
      '  border: 1px solid #4a4a4a; border-radius: 4px; padding: 6px; font-family: monospace; font-size: 0.95em; }',
      '#tes-panel .tes-foot { margin-top: 8px; opacity: 0.7; font-size: 0.95em; }',
      '#tes-panel a { color: #7ee081; }',
    ].join('\n');
    // Reading head/body is a property access on a document we do not own; a
    // page that throws here must still get its panel.
    let parent = null;
    try { parent = doc.head || doc.body; } catch (e) { parent = null; }
    if (parent && parent.appendChild) parent.appendChild(style);
  }

  // The header names the view you are looking at, so a collapsed-then-reopened
  // panel is not ambiguous about what it is showing.
  const VIEW_TITLES = { schedule: 'Education Scheduler', settings: 'Settings', grid: 'Degrees', focus: 'Focus' };

  // The shell only: chrome, the failure line, the nav row, and the view
  // switch. Each view owns its own body content, so adding a view never grows
  // this function.
  //
  // This summary said "the error short-circuit" for a release after the
  // short-circuit was deleted, while the block below it described the removal
  // in full — the fourth comment in this file to outlive the thing it
  // described. They share a shape: each stated a *mechanism* ("it returns
  // here", "it is shared with X") rather than an *invariant* ("the failure is
  // always visible", "renderPanel is always handed a complete model"). A
  // mechanism is true until someone changes it and silently false afterwards;
  // an invariant is what the next reader actually needs, and a false one is
  // usually caught because the code visibly contradicts it. Prefer invariants.
  function renderPanel(doc, mount, model, handlers) {
    injectStyleOnce(doc);

    const existing = queryOne(doc, '#tes-panel');
    if (existing && existing.remove) existing.remove();

    const panel = doc.createElement('div');
    panel.id = 'tes-panel';
    panel.setAttribute('data-tes-version', SCRIPT_VERSION);

    const view = model.view || 'schedule';

    const header = doc.createElement('div');
    header.className = 'tes-header';
    header.textContent = `${VIEW_TITLES[view] || VIEW_TITLES.schedule} — ${model.collapsed ? 'show' : 'hide'}`;
    if (header.addEventListener) header.addEventListener('click', handlers.onToggle);
    panel.appendChild(header);

    if (!model.collapsed) {
      const body = doc.createElement('div');

      // The failure is stated first and stays visible, but it no longer
      // swallows the rest of the panel. This used to return here, before the
      // nav row — which put the debug report (it lives in the settings view)
      // out of reach in the one situation it exists for: a player whose panel
      // says "Couldn't load your education data" is exactly the player who
      // needs to send someone a report. It also stranded the settings form,
      // every control of which is the player's own input and none of which
      // needs the payload, along with NO_INFERENCE's "Enter what you hold".
      if (model.status === 'error') {
        const failure = doc.createElement('div');
        failure.className = 'tes-error';
        failure.textContent = model.message;
        body.appendChild(failure);
      }

      // The view controls sit above the body so they keep their position as
      // the body's height changes between views.
      //
      // noopHandlers is init()'s signal that nothing on this panel can respond
      // — it uses it for a draw() that threw. Buttons that render and do
      // nothing are worse than no buttons: they invite a click that reads as
      // the script being broken twice over. Identity, not a shape check: any
      // real handler set is a different object.
      if (handlers !== noopHandlers) {
        const nav = doc.createElement('div');
        nav.className = 'tes-nav';
        for (const target of ['schedule', 'grid', 'focus', 'settings']) {
          if (target === view) continue;
          const btn = doc.createElement('button');
          btn.textContent = target === 'settings' ? '⚙ settings' : target === 'grid' ? 'degrees' : target === 'focus' ? 'focus' : 'schedule';

          // Focus mode has one switch — Queue order, in the settings view —
          // and this is the same switch, not a second one. Disabled rather
          // than absent: a missing button is a puzzle, a disabled one says
          // the feature exists and that something turns it on. The title
          // says what.
          if (target === 'focus' && model.settings.orderMode !== 'focus') {
            btn.disabled = true;
            btn.setAttribute('title', 'Set Queue order to "My focus first" in settings to use this');
          }

          if (btn.addEventListener && handlers.onViewChange) {
            // Guarded explicitly on btn.disabled: some fake-document
            // harnesses (and a native button carrying only the disabled
            // attribute rather than the property) still dispatch a click
            // event, and a disabled control must not act regardless of
            // whether the host is a real browser suppressing it for us.
            btn.addEventListener('click', function () {
              if (btn.disabled) return;
              handlers.onViewChange(target);
            });
          }
          nav.appendChild(btn);
        }
        body.appendChild(nav);
      }

      // Settings renders in full either way — it reads nothing from the
      // payload. Schedule, Degrees and Focus have nothing to draw without
      // data, and the failure line above is the whole of what they have to
      // say, so they are skipped rather than rendered empty.
      if (view === 'settings') renderSettingsView(doc, body, model, handlers);
      else if (model.status === 'error') { /* the failure line is the view */ }
      else if (view === 'grid') renderGridView(doc, body, model, handlers);
      else if (view === 'focus') renderFocusView(doc, body, model, handlers);
      else renderScheduleView(doc, body, model, handlers);

      panel.appendChild(body);
    }

    mount.appendChild(panel);
    return panel;
  }

  // Which settings paths carry a number, so onSettingChange knows what to
  // coerce. orderMode is a string enum: running it through Number() would make
  // every choice NaN, and normaliseSettings would quietly restore the default
  // — a preference that silently refuses to change.
  const NUMERIC_SETTING_FIELDS = [
    'maxCooldownHours', 'booksOwned', 'bookPrice', 'jobPoints', 'perks.meritsPercent',
  ];

  // A labelled section per group, not a flat list: later releases add fields
  // and the shell has to absorb them without restructuring.
  function settingsSection(doc, body, title) {
    const section = doc.createElement('div');
    section.className = 'tes-section';
    const heading = doc.createElement('div');
    heading.className = 'tes-section-title';
    heading.textContent = title;
    section.appendChild(heading);
    body.appendChild(section);
    return section;
  }

  function numberField(doc, section, label, value, onCommit) {
    const row = doc.createElement('div');
    row.className = 'tes-row';
    const text = doc.createElement('span');
    text.textContent = label;
    row.appendChild(text);
    const input = doc.createElement('input');
    input.setAttribute('type', 'number');
    input.setAttribute('min', '0');
    input.value = String(value);
    if (input.addEventListener) {
      input.addEventListener('change', function () { onCommit(input.value); });
    }
    row.appendChild(input);
    section.appendChild(row);
    return input;
  }

  // Three states, not two. A perk is `true`, `false`, or `null` — and `null`
  // ("has not said") is the state this whole feature turns on, because it is
  // what stops an ambiguous reduction from being answered on the player's
  // behalf. A checkbox has nowhere to put it: an unticked box for a question
  // nobody asked reads as a stated "no", which is the panel inventing an
  // answer — exactly what the inference itself refuses to do.
  const TRI_STATE_OPTIONS = [
    { value: '', label: 'Not set' },
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
  ];

  function triStateField(doc, section, label, value, onCommit) {
    const row = doc.createElement('div');
    row.className = 'tes-row';
    const text = doc.createElement('span');
    text.textContent = label;
    row.appendChild(text);
    const select = doc.createElement('select');
    const current = value === true ? 'yes' : value === false ? 'no' : '';
    for (const option of TRI_STATE_OPTIONS) {
      const opt = doc.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      if (option.value === current) opt.selected = true;
      select.appendChild(opt);
    }
    select.value = current;
    if (select.addEventListener) {
      select.addEventListener('change', function () {
        onCommit(select.value === 'yes' ? true : select.value === 'no' ? false : null);
      });
    }
    row.appendChild(select);
    section.appendChild(row);
    return select;
  }

  function renderSettingsView(doc, body, model, handlers) {
    const s = model.settings;
    const set = handlers.onSettingChange || function () {};

    // Settings and the plan live under separate keys and fail separately, so a
    // settings write that did not land is reported here rather than on the
    // schedule view, where nothing the player just did would explain it.
    if (model.settingsSaveError) {
      const saveError = doc.createElement('div');
      saveError.className = 'tes-save-error';
      saveError.textContent = "Couldn't save your settings — your last change may not persist.";
      body.appendChild(saveError);
    }

    const boosters = settingsSection(doc, body, 'Boosters');
    numberField(doc, boosters, 'Max booster cooldown (hours)', s.maxCooldownHours, function (v) { set('maxCooldownHours', v); });
    numberField(doc, boosters, 'Books of Carols owned', s.booksOwned, function (v) { set('booksOwned', v); });
    numberField(doc, boosters, 'Book of Carols price', s.bookPrice, function (v) { set('bookPrice', v); });
    numberField(doc, boosters, 'Job points available', s.jobPoints, function (v) { set('jobPoints', v); });
    // Torn already applies job points to the course in progress, so
    // activeCourse.completedAt already reflects them — there is nothing here
    // for this field to correct. It is recorded only so it travels with a
    // shared plan string and a debug report.
    const jobPointsNote = doc.createElement('div');
    jobPointsNote.className = 'tes-note';
    jobPointsNote.textContent = 'Job points need no entry for the dates shown here — Torn already applies them to the course in progress.';
    boosters.appendChild(jobPointsNote);

    const perks = settingsSection(doc, body, 'Education perks');
    // The note carries the honesty: it names the inference as an inference, so
    // a prefilled field is never mistaken for something we read off the account.
    const note = doc.createElement('div');
    note.className = 'tes-note';
    note.textContent = model.perkInference.note;
    perks.appendChild(note);
    numberField(doc, perks, 'Merits reduction (%)', s.perks.meritsPercent === null ? '' : s.perks.meritsPercent, function (v) { set('perks.meritsPercent', v); });
    triStateField(doc, perks, 'Principal rank (10%)', s.perks.principal, function (v) { set('perks.principal', v); });
    triStateField(doc, perks, 'WSU stock block (10%)', s.perks.wsuBlock, function (v) { set('perks.wsuBlock', v); });

    const planning = settingsSection(doc, body, 'Planning');
    const modeRow = doc.createElement('div');
    modeRow.className = 'tes-row';
    const modeLabel = doc.createElement('span');
    modeLabel.textContent = 'Queue order';
    modeRow.appendChild(modeLabel);
    const modeSelect = doc.createElement('select');
    for (const mode of model.orderModes) {
      const opt = doc.createElement('option');
      opt.value = mode.id;
      opt.textContent = mode.label;
      if (mode.id === s.orderMode) opt.selected = true;
      modeSelect.appendChild(opt);
    }
    if (modeSelect.addEventListener) {
      modeSelect.addEventListener('change', function () { set('orderMode', modeSelect.value); });
    }
    modeRow.appendChild(modeSelect);
    planning.appendChild(modeRow);

    // The one thing this control must not be allowed to imply. Several
    // community guides present an ordering as a way to finish sooner; it is
    // not, and a panel that stays silent here lets the player carry that
    // belief into a choice it just offered them.
    const orderNote = doc.createElement('div');
    orderNote.className = 'tes-note';
    orderNote.textContent = 'Order does not change the finish date — courses run one at a time, so the total is the same either way. It changes how soon each course’s bonus starts paying off. It can also turn a queue with no date into one with a date: a queue whose courses are all valid but listed out of sequence can fail as-listed and succeed under the other two modes, which reorder to something followable.';
    planning.appendChild(orderNote);

    const help = settingsSection(doc, body, 'Help');

    // One compact line, and nothing at all while the URL is unresolved — not a
    // dead link, not a "#" href, not placeholder text pretending to be a link.
    if (FORUM_POST_URL) {
      const guide = doc.createElement('div');
      const link = doc.createElement('a');
      link.setAttribute('href', FORUM_POST_URL);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.textContent = 'A beginner’s guide to education — which courses to take first, and why';
      guide.appendChild(link);
      const ask = doc.createElement('div');
      ask.className = 'tes-note';
      ask.textContent = 'If it helped, a like on the post surfaces it for the next new player.';
      guide.appendChild(ask);
      help.appendChild(guide);
    }

    const reportBtn = doc.createElement('button');
    reportBtn.textContent = model.debugReport ? 'hide debug report' : 'build debug report';
    if (reportBtn.addEventListener && handlers.onToggleDebugReport) {
      reportBtn.addEventListener('click', handlers.onToggleDebugReport);
    }
    help.appendChild(reportBtn);

    // Shown before it can be copied. A copy button that hides its payload is
    // how people leak things they did not know they had.
    if (model.debugReport) {
      const pre = doc.createElement('pre');
      pre.className = 'tes-report';
      pre.textContent = model.debugReport;
      help.appendChild(pre);
      const copy = doc.createElement('button');
      copy.textContent = 'copy';
      if (copy.addEventListener && handlers.onCopyDebugReport) {
        copy.addEventListener('click', handlers.onCopyDebugReport);
      }
      help.appendChild(copy);
    }

    // The one place in this script that takes text from outside the player's
    // own browser. Everything it can produce is data: the box is a textarea
    // written through `.value`, the error below it goes in through
    // textContent, and decodePlan validates every id against the live
    // catalogue before any of it reaches a plan.
    const share = settingsSection(doc, body, 'Share this plan');
    const shareBox = doc.createElement('textarea');
    shareBox.className = 'tes-share';
    shareBox.value = model.shareText || '';
    shareBox.setAttribute('rows', '3');
    shareBox.setAttribute('spellcheck', 'false');
    share.appendChild(shareBox);

    const importBtn = doc.createElement('button');
    importBtn.textContent = 'import from this box';
    if (importBtn.addEventListener && handlers.onImportPlan) {
      importBtn.addEventListener('click', function () { handlers.onImportPlan(shareBox.value); });
    }
    share.appendChild(importBtn);

    if (model.importError) {
      const err = doc.createElement('div');
      err.className = 'tes-save-error';
      err.textContent = model.importError;
      share.appendChild(err);
    }
  }

  // One section per taxonomy category, each offering its selections as a
  // checkbox plus what is left of it. The one control this view does NOT
  // offer is Queue order itself — that lives in Settings, and is the single
  // switch that turns this whole view on (see the nav row in renderPanel).
  function renderFocusView(doc, body, model, handlers) {
    // A guard on the model contract, not a state this panel produces:
    // renderPanel reaches this renderer only on a non-error model, and every
    // non-error model carries focusGroups. It is here, the same as
    // renderGridView's equivalent guard, so a renderer handed a bare model
    // never meets an undefined.
    if (!model.focusGroups) {
      const none = doc.createElement('div');
      none.className = 'tes-summary';
      none.textContent = 'No course data, so no focus figures.';
      body.appendChild(none);
      return;
    }

    // The one thing this view must not be left to imply — see the settings
    // view's identical worry about Queue order in general. Focus reorders;
    // it does not shorten or lengthen anything, because courses still run
    // one at a time and the sum is order-independent.
    const orderNote = doc.createElement('div');
    orderNote.className = 'tes-note';
    orderNote.textContent = 'Choosing a focus changes the order courses are queued in — it does not change the finish date. The total time is the same either way; a focus just moves the courses that earn it earlier, so that benefit starts paying off sooner.';
    body.appendChild(orderNote);

    // Torn does not attach a learningOutcomes entry to every course. Silence
    // on 31 of them would read as "these have nothing," which is wrong for
    // the ones whose only benefit is a working-stat gain — the one category
    // this view computes rather than classifies.
    const outcomeNote = doc.createElement('div');
    outcomeNote.className = 'tes-note';
    outcomeNote.textContent = '31 courses grant no learning outcome at all. Working Stats is the only focus category that can still reach them.';
    body.appendChild(outcomeNote);

    // A stale or unmapped count names a live disagreement between the
    // taxonomy and today's payload — shown, never swallowed, because a silent
    // zero here would rank a real benefit as worthless or trust a judgement
    // that no longer applies.
    if (model.focusHealth && (model.focusHealth.stale > 0 || model.focusHealth.unmapped > 0)) {
      const healthNote = doc.createElement('div');
      healthNote.className = 'tes-note';
      healthNote.textContent = `Focus data health: ${model.focusHealth.stale} classification${model.focusHealth.stale === 1 ? '' : 's'} out of date, ${model.focusHealth.unmapped} outcome${model.focusHealth.unmapped === 1 ? '' : 's'} not yet classified.`;
      body.appendChild(healthNote);
    }

    const toggle = handlers.onFocusToggle || function () {};
    const reprioritise = handlers.onFocusPriority || function () {};

    for (const group of model.focusGroups) {
      const section = settingsSection(doc, body, group.category);
      for (const sel of group.selections) {
        const row = doc.createElement('div');
        row.className = 'tes-row';

        const box = doc.createElement('input');
        box.setAttribute('type', 'checkbox');
        // A single control either way: toggleFocus reads the player's
        // current focuses to decide select, deselect or swap, so every
        // checkbox — chosen or not — commits through the same call.
        if (sel.priority !== null) box.checked = true;
        if (box.addEventListener) {
          box.addEventListener('change', function () { toggle(group.category, sel.selection); });
        }
        row.appendChild(box);

        const label = doc.createElement('span');
        label.textContent = sel.selection;
        row.appendChild(label);

        const remaining = doc.createElement('span');
        remaining.textContent = sel.remainingLabel;
        row.appendChild(remaining);

        // Only once chosen: an unchosen selection has no number to change,
        // and a renumbering control for something not on the list yet would
        // invite a click that means nothing. Each chosen focus renders its
        // own number beside it; there is no default and no greyed-out zero.
        if (sel.priority !== null) {
          const priorityInput = doc.createElement('input');
          priorityInput.className = 'tes-focus-priority';
          priorityInput.setAttribute('type', 'number');
          priorityInput.setAttribute('min', '1');
          priorityInput.value = String(sel.priority);
          if (priorityInput.addEventListener) {
            priorityInput.addEventListener('change', function () {
              reprioritise(group.category, sel.selection, Number(priorityInput.value));
            });
          }
          row.appendChild(priorityInput);
        }

        section.appendChild(row);
      }
    }
  }

  // One box per degree plus one for everything, each answering the same
  // question independently: if I did only this, starting now, when would it
  // finish? Every name here is Torn's, so every one goes in through
  // textContent.
  function renderGridView(doc, body, model, handlers) {
    // A guard on the model contract, not a state this panel produces:
    // renderPanel reaches this renderer only on a non-error model, and every
    // non-error model carries a grid. It is here so a renderer handed a model
    // never meets an undefined — the same reason errorModel carries fields
    // nothing currently reads.
    if (!model.grid) {
      const none = doc.createElement('div');
      none.className = 'tes-summary';
      none.textContent = 'No course data, so no degree estimates.';
      body.appendChild(none);
      return;
    }

    const intro = doc.createElement('div');
    intro.className = 'tes-summary';
    intro.textContent = 'Each box answers: if I did only this degree, starting now, when would it finish?';
    body.appendChild(intro);

    const grid = doc.createElement('div');
    grid.className = 'tes-grid';
    for (const box of model.grid.boxes) {
      const cell = doc.createElement('div');
      cell.className = box.key === 'all' ? 'tes-cell tes-cell-all' : 'tes-cell';
      const title = doc.createElement('div');
      title.className = 'tes-cell-title';
      title.textContent = box.bachelorPrefix ? `${box.name} (${box.bachelorPrefix})` : box.name;
      cell.appendChild(title);
      const detail = doc.createElement('div');
      detail.textContent = box.courseCount === 0
        ? 'Already complete'
        : `${box.courseCount} courses — ${box.durationLabel}\n${box.finishLabel}`;
      detail.className = 'tes-cell-detail';
      cell.appendChild(detail);
      grid.appendChild(cell);
    }
    body.appendChild(grid);

    // The number on this screen that looks wrong, and it looks wrong every
    // time: eleven degrees dated 2026 above an all-courses box dated 2029.
    // Every box starts from today by design — that is the question the view
    // answers — so the *dates* overlap and cannot be read in sequence.
    //
    // The *durations* are a different matter, and the second sentence used to
    // get it wrong. It claimed doing everything takes "not the sum of the
    // others", which is true only in a catalogue where degrees share courses.
    // Today they do not: the twelve box durations add to the all-courses
    // duration to the second (tests/grid.test.js pins the equality). A player
    // who added them up and read that sentence would have caught the panel
    // contradicting itself — the exact reaction this note exists to prevent.
    // So it now says the durations do add up, and uses that to explain the
    // date rather than to deny it.
    const overlap = doc.createElement('div');
    overlap.className = 'tes-note';
    overlap.textContent = 'The dates overlap: each starts from today, as if you did that degree and nothing else, so they cannot be read as a sequence. The durations do add up — that is why doing all of them lands on the all-courses box’s date, years past any single degree.';
    body.appendChild(overlap);

    // A separate fact, and currently a quiet one: Torn keeps a course's
    // prerequisites inside its own category, so the boxes do sum today and
    // this line does not appear. It is here for the catalogue where they stop
    // doing that — a reader who adds the boxes up, gets a bigger number than
    // the all-courses box and finds no explanation concludes the tool is
    // broken. tests/grid.test.js drives both directions through the DOM
    // against a real shared prerequisite, not by flipping the flag.
    if (model.grid.sumsDiffer) {
      const caveat = doc.createElement('div');
      caveat.className = 'tes-note';
      caveat.textContent = 'These do not add up to the all-courses total, and should not: degrees share prerequisite courses, so a shared course is counted once by every degree that needs it.';
      body.appendChild(caveat);
    }
  }

  // The default view: the queue, its finish date, and the add/remove controls.
  function renderScheduleView(doc, body, model, handlers) {
    if (model.saveError) {
      const saveError = doc.createElement('div');
      saveError.className = 'tes-save-error';
      saveError.textContent = "Couldn't save your plan — your last change may not persist.";
      body.appendChild(saveError);
    }

    // The finish date is the number this whole tool exists to produce, so
    // it gets its own prominent line rather than sitting mid-paragraph in
    // the summary below.
    if (model.finishLabel) {
      const finish = doc.createElement('div');
      finish.className = 'tes-finish';
      finish.textContent = `Queue finishes: ${model.finishLabel}`;
      body.appendChild(finish);
    }

    // Null whenever the finish date is withheld (buildPanelModel), so this
    // block never appears beside a queue that cannot be followed.
    if (model.consumables) {
      const c = model.consumables;
      const boost = doc.createElement('div');
      boost.className = 'tes-summary';
      const lines = [];
      if (c.plannedBooks > 0) {
        lines.push(`With ${c.plannedBooks} Book${c.plannedBooks === 1 ? '' : 's'} of Carols: ${c.plannedFinishLabel} (${c.plannedDurationLabel})`);
      }
      // The cost is not decoration. A floor date without it is a number
      // nobody can act on — and "$0", which is what an unset price would
      // arithmetically produce, is worse than no figure at all: it reads as
      // "the floor is free". Name the gap instead, and say how to close it.
      const costText = c.floorCostLabel || 'cost unknown, no Book price set';
      lines.push(`Floor with maximum Books (${c.floorBooks} — ${costText}): ${c.floorFinishLabel} (${c.floorDurationLabel})`);
      if (!c.floorCostLabel) {
        lines.push('Set a Book price in settings to see what that floor would cost.');
      }
      lines.push('Books shorten queued course time. Time already running on your current course is not affected.');
      boost.textContent = lines.join('\n');
      body.appendChild(boost);
    }

    const summary = doc.createElement('div');
    summary.className = 'tes-summary';
    const lines = [`Perk reduction: ${model.reductionLabel}`];
    if (model.finishLabel) {
      lines.push(`Total queued time: ${model.totalLabel}`);
    } else if (model.queue.length === 0) {
      lines.push('Queue is empty. Add a course below.');
    } else {
      // finishLabel is withheld (buildPanelModel) whenever problems is
      // non-empty — a queue with unmet prerequisites is not a plan the
      // player can actually follow, so no total is safe to print. The
      // per-course detail lands below via the problems loop.
      lines.push('This queue cannot be followed as ordered — missing prerequisites below.');
    }
    for (const entry of model.stale) {
      lines.push(`Removed ${entry.prefix || entry.courseId} from your queue — ${entry.why}.`);
    }
    for (const problem of model.problems) {
      lines.push(`${problem.prefix} needs ${problem.missing.map(function (m) { return m.prefix; }).join(', ')}`);
    }
    // textContent throughout, never innerHTML: course names come from Torn
    // and are not ours to trust into markup.
    summary.textContent = lines.join('\n');
    body.appendChild(summary);

    for (const item of model.queue) {
      const row = doc.createElement('div');
      row.className = 'tes-row';
      const label = doc.createElement('span');
      label.textContent = `${item.prefix} ${item.name} — ${item.durationLabel} — finishes ${item.finishLabel}`;
      row.appendChild(label);
      const remove = doc.createElement('button');
      remove.textContent = 'remove';
      remove.dataset.courseId = String(item.courseId);
      if (remove.addEventListener) {
        remove.addEventListener('click', function () { handlers.onRemove(item.courseId); });
      }
      row.appendChild(remove);
      body.appendChild(row);
    }

    const picker = doc.createElement('select');
    // A real <select> selects its first option, so whatever sits at the top is
    // what an unopened picker submits. That must not be "all 115 courses":
    // there is no bulk undo in this panel — removal is one course at a time —
    // so a stray click on `add` before touching the dropdown would cost the
    // player 115 clicks to walk back. An inert first entry is what the add
    // button's `picker.value === ''` guard was always written against; without
    // it that guard is unreachable in a browser whenever any option exists.
    const placeholder = doc.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— choose a course —';
    if (model.selectedCourseId == null) placeholder.selected = true;
    picker.appendChild(placeholder);
    // Second, so it is reachable without scrolling a ~115-entry list, but never
    // the default. Only when there is something left to add: an entry reading
    // "all remaining (0)" invites a click that can do nothing.
    if (model.addable.length > 0) {
      const allOpt = doc.createElement('option');
      allOpt.value = ALL_COURSES_OPTION;
      allOpt.textContent = `— all remaining courses (${model.addable.length}) —`;
      if (model.selectedCourseId === ALL_COURSES_OPTION) allOpt.selected = true;
      picker.appendChild(allOpt);
    }
    for (const option of model.addable) {
      const opt = doc.createElement('option');
      opt.value = String(option.courseId);
      // The label already carries the bachelor marker, built once in the model
      // rather than reassembled per render. textContent, never innerHTML.
      opt.textContent = option.label;
      // Rebuilding the list on every draw would otherwise reset the
      // scroll position back to the top of a ~130-entry list on every add.
      if (model.selectedCourseId != null && option.courseId === model.selectedCourseId) {
        opt.selected = true;
      }
      picker.appendChild(opt);
    }
    if (picker.addEventListener && handlers.onPickerChange) {
      picker.addEventListener('change', function () { handlers.onPickerChange(picker.value); });
    }
    const add = doc.createElement('button');
    add.textContent = 'add';
    if (add.addEventListener) {
      add.addEventListener('click', function () {
        // An empty addable list leaves picker.value === '', and
        // Number('') is 0 — a valid-looking integer that is not a real
        // selection. Guard on the selection itself, not just its shape.
        if (picker.value === '') return;
        // Before the numeric conversion, not after: the sentinel is a string
        // and Number() would turn it into NaN, which the integer guard would
        // then swallow silently.
        if (picker.value === ALL_COURSES_OPTION) { handlers.onAddAll(); return; }
        const chosen = Number(picker.value);
        if (Number.isInteger(chosen)) handlers.onAdd(chosen);
      });
    }
    body.appendChild(picker);
    body.appendChild(add);

    // One unobtrusive line: a player who needs the guide will not go looking
    // in settings for it, but the schedule view must not become an advert.
    // Null URL renders nothing at all, exactly as in the settings view.
    if (FORUM_POST_URL) {
      const foot = doc.createElement('div');
      foot.className = 'tes-foot';
      const link = doc.createElement('a');
      link.setAttribute('href', FORUM_POST_URL);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.textContent = 'New to education? Read the guide.';
      foot.appendChild(link);
      body.appendChild(foot);
    }
  }

  // Leaving the education page has to take the panel with it: Torn's SPA
  // swaps the page content without a load, so a panel left behind would sit on
  // an unrelated page quoting a plan nobody asked for. Both ids are removed —
  // #tes-fallback-mount is ours too, and orphaning it leaks a fixed-position
  // container over the rest of the site.
  function unmountPanel(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return;
    for (const id of ['#tes-panel', '#tes-fallback-mount']) {
      const el = queryOne(doc, id);
      if (el && typeof el.remove === 'function') el.remove();
    }
  }

  // Torn is a single-page app: arriving at education from the sidebar fires no
  // page load, so @run-at document-idle never runs again and the panel simply
  // is not there. Three signals, because no one of them is reliable alone:
  // history patches catch programmatic navigation, popstate catches the back
  // button, and the MutationObserver catches a route change Torn makes without
  // touching history at all — including one where only the page content is
  // swapped. The observer is a route-change signal only. Noticing that a
  // re-render dropped our panel while the route never changed is the
  // bootstrap's job, in syncToRoute below.
  const NAV_INSTALLED_FLAG = '__tesNavInstalled';

  function observeNavigation(doc, win, handlers) {
    if (!win || win[NAV_INSTALLED_FLAG]) return function () {};
    win[NAV_INSTALLED_FLAG] = true;

    const notify = function () {
      try { handlers.onRouteChange(); } catch (e) { /* a bad handler must not break navigation */ }
    };

    const history = win.history;
    const originals = {};
    if (history) {
      for (const name of ['pushState', 'replaceState']) {
        if (typeof history[name] === 'function') {
          originals[name] = history[name];
          history[name] = function () {
            const result = originals[name].apply(this, arguments);
            notify();
            return result;
          };
        }
      }
    }

    if (typeof win.addEventListener === 'function') win.addEventListener('popstate', notify);

    let observer = null;
    const Observer = win.MutationObserver;
    if (typeof Observer === 'function' && doc && doc.documentElement) {
      try {
        observer = new Observer(function () { notify(); });
        observer.observe(doc.documentElement, { childList: true, subtree: true });
      } catch (e) { observer = null; }
    }

    return function disconnect() {
      if (history) {
        for (const name of Object.keys(originals)) history[name] = originals[name];
      }
      if (typeof win.removeEventListener === 'function') win.removeEventListener('popstate', notify);
      if (observer && typeof observer.disconnect === 'function') observer.disconnect();
      win[NAV_INSTALLED_FLAG] = false;
    };
  }

  // The model for the two failures init() has to render without a panel model:
  // a draw() that threw, and a mount phase that could not read the page.
  //
  // buildPanelModel does NOT use this. Its fetch-failure path builds an
  // equivalent shape inline, because that one carries the player's real plan,
  // settings and collapsed state while this one cannot know them. The two
  // therefore have to be kept in step by hand — a field added to one and not
  // the other is a renderer meeting an undefined on whichever path is rarer.
  function errorModel(message) {
    return {
      status: 'error', message: message, reductionLabel: null,
      queue: [], addable: [], stale: [], problems: [], finishLabel: null, totalLabel: null,
      collapsed: false, saveError: false, selectedCourseId: null, view: 'schedule',
      // Unread today, but check the mechanism before trusting that: this model
      // carries view: 'schedule', and renderPanel skips the schedule and grid
      // renderers on an error model, so nothing reaches them. It is NOT the
      // old short-circuit that keeps them unread — that was removed, and the
      // comment saying so outlived the code by a whole review cycle. They are
      // here so the fact stays incidental rather than load-bearing: a renderer
      // handed this model must not meet an undefined.
      settings: normaliseSettings(null), settingsSaveError: false,
      // The real list rather than an empty one, for the reason given directly
      // above and for no stronger one. Check the mechanism before believing a
      // claim of reachability here: BOTH errorModel call sites pass
      // noopHandlers, renderPanel suppresses the nav row on an identity match
      // with noopHandlers, and this model hardcodes view: 'schedule' — so the
      // settings view is NOT reachable from a rendered error model and the
      // empty array was never drawn. It is corrected because an empty list
      // would draw an optionless dropdown if that ever changed, which is what
      // this whole field group is here to prevent.
      perkInference: NO_INFERENCE, orderModes: ORDER_MODE_LABELS, debugReport: null, grid: null,
      // Same trio buildPanelModel's failure model carries, for the same
      // reason: no catalogue means no registry to check and no totals to
      // state.
      focusGroups: null, focuses: null, focusHealth: null,
      consumables: null,
      // Same pair buildPanelModel carries, for the reason the comment above
      // gives: a renderer handed this model must not meet an undefined.
      shareText: '', importError: null,
    };
  }

  const noopHandlers = {
    onToggle: function () {}, onAdd: function () {}, onRemove: function () {},
    onAddAll: function () {},
    onPickerChange: function () {}, onViewChange: function () {},
    onSettingChange: function () {},
    onToggleDebugReport: function () {}, onCopyDebugReport: function () {},
    // renderFocusView (reachable only via renderPanel's view dispatch, which
    // guards its own calls with `|| function(){}`) does not strictly need
    // these to exist here — but every other handler renderSettingsView calls
    // is kept for shape completeness, and these are the same kind of caller.
    onFocusToggle: function () {}, onFocusPriority: function () {},
    // renderSettingsView (the only renderer that calls onImportPlan) is
    // unreachable through this handler set: both errorModel call sites pass
    // noopHandlers, errorModel hardcodes view: 'schedule', and renderPanel
    // suppresses the .tes-nav row on a noopHandlers identity match, so there
    // is no route to the settings view and no import click to ignore. Kept
    // anyway for shape completeness — any real handler set carries it, and a
    // caller that starts building the settings view against this object
    // (directly, bypassing renderPanel's routing) must not throw.
    onImportPlan: function () {},
  };

  async function init() {
    const plan = loadPlan();
    let settings = loadSettings();
    let settingsSaveFailed = false;
    // Two acquisition paths: the endpoint, then Torn's own React tree. The
    // panel keeps calling this value fetchResult because buildPanelModel's
    // contract has not changed — only where the data may have come from.
    const fetchResult = await acquireEducationData(document);

    // The design requires the panel to be visible even when Torn's markup
    // does not match any known mount selector, rather than rendering
    // nothing with no explanation.
    //
    // findMountPoint runs our selectors against a document we do not control,
    // and init() is now called again on every route change rather than once at
    // load. An unguarded throw here becomes an unhandled rejection and the page
    // goes blank with no hint why — the same failure draw()'s try/catch below
    // already exists to prevent, so the discipline extends to this phase too.
    let mount = null;
    let mountError = null;
    try {
      mount = findMountPoint(document);
    } catch (e) {
      mountError = (e && e.message) || String(e);
      mount = null;
    }
    if (!mount) {
      try {
        mount = document.createElement('div');
        mount.id = 'tes-fallback-mount';
        mount.style.position = 'fixed';
        mount.style.bottom = '12px';
        mount.style.right = '12px';
        mount.style.zIndex = '2147483647';
        document.body.appendChild(mount);
      } catch (e) {
        // There is nowhere left to draw, so there is no way to show this in
        // the panel. Returning null is the honest end of the line: the host
        // document is unusable and rejecting would only blank the page.
        return null;
      }
    }

    // Prefill only where the decomposition is provably unique, and only into
    // fields the player has not already answered — null means "has not said",
    // which is distinct from zero, and overwriting an answer they typed would
    // be the panel arguing with them. An inferred value is never presented as
    // a reading: the note above the fields says where it came from.
    //
    // Intentional, so nobody "fixes" it: clearing a perk back to "Not set" and
    // reloading refills it. null means "has not said", and on the next visit
    // the player still has not said — the decomposition is provably unique, so
    // the same value is offered again. Persisting a refusal would need a fourth
    // state, and there is nothing here worth that.
    function prefillPerks(data) {
      if (!data) return;
      const inference = inferPerks(data.reduction);
      if (!inference.determinate) return;
      let changed = false;
      const next = JSON.parse(JSON.stringify(settings));
      if (next.perks.meritsPercent === null) { next.perks.meritsPercent = inference.meritsPercent; changed = true; }
      if (next.perks.principal === null) { next.perks.principal = inference.principal; changed = true; }
      if (next.perks.wsuBlock === null) { next.perks.wsuBlock = inference.wsuBlock; changed = true; }
      if (!changed) return;
      // normaliseSettings is the only writer of the canonical shape.
      settings = normaliseSettings(next);
      settingsSaveFailed = !saveSettings(settings);
    }
    prefillPerks(fetchResult.ok ? fetchResult.data : null);

    let selectedCourseId = null;
    // Built on demand and never persisted: it is a snapshot of one moment's
    // failure, and a stale one pasted into a forum thread describes a bug
    // nobody is looking at any more.
    let debugReport = null;
    // Held in this closure, not persisted: collapsed is a standing preference,
    // but which view you last opened is not. A player who hides the panel wants
    // it hidden next visit; a player who opened settings once does not want
    // settings every visit.
    let view = 'schedule';
    // Cleared by the next successful import, never persisted: it describes one
    // paste, and a stale reason beside a plan that imported fine is a lie.
    let importError = null;

    // draw/buildPanelModel/renderPanel are unguarded and schedule() throws
    // plain Errors on unexpected input; without this the throw becomes an
    // unhandled rejection (init is async) and the page goes blank with no
    // hint why. Catching here keeps the failure inside the panel instead.
    function draw(currentPlan, saveFailed) {
      try {
        const model = buildPanelModel({
          fetchResult: fetchResult,
          plan: currentPlan,
          now: Math.floor(Date.now() / 1000),
          saveFailed: saveFailed === true,
          settings: settings,
          settingsSaveFailed: settingsSaveFailed,
          selectedCourseId: selectedCourseId,
          view: view,
          debugReport: debugReport,
          importError: importError,
        });

        function commit(next) {
          const saved = savePlan(next);
          draw(next, !saved);
        }

        return renderPanel(document, mount, model, {
          onToggle: function () {
            commit({ queue: currentPlan.queue, collapsed: !currentPlan.collapsed });
          },
          onAdd: function (courseId) {
            if (currentPlan.queue.indexOf(courseId) !== -1) return;
            // Queue the whole prerequisite chain, not just the course the
            // player picked — the panel must never invite a plan validateQueue
            // will reject. requiredCoursesFor already excludes completed
            // courses and ends with courseId itself; only skip what is
            // already queued so existing order is preserved. It is handed
            // plannedCompletions rather than completedIds so it never emits the
            // course being served now — buildPanelModel would strip that from
            // the queue as stale, leaving whatever depended on it stranded.
            const data = fetchResult.ok ? fetchResult.data : null;
            const required = data
              ? requiredCoursesFor(courseId, plannedCompletions(data.completedIds, data.courses, data.activeCourse), data.courses)
              : [courseId];
            const toAdd = required.filter(function (id) { return currentPlan.queue.indexOf(id) === -1; });
            if (toAdd.length === 0) return;
            commit({ queue: currentPlan.queue.concat(toAdd), collapsed: currentPlan.collapsed });
          },
          // The whole catalogue, in an order validateQueue accepts, appended
          // after whatever is already queued — adding everything must not
          // reorder or discard a plan the player already built.
          onAddAll: function () {
            const data = fetchResult.ok ? fetchResult.data : null;
            if (!data) return;
            const everything = allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
            const toAdd = everything.filter(function (id) { return currentPlan.queue.indexOf(id) === -1; });
            if (toAdd.length === 0) return;
            commit({ queue: currentPlan.queue.concat(toAdd), collapsed: currentPlan.collapsed });
          },
          onRemove: function (courseId) {
            commit({
              queue: currentPlan.queue.filter(function (id) { return id !== courseId; }),
              collapsed: currentPlan.collapsed,
            });
          },
          onPickerChange: function (value) {
            // The sentinel is preserved rather than coerced: Number('__all__')
            // is NaN, so the integer guard below would reset the picker to the
            // top of the list on the next redraw.
            if (value === ALL_COURSES_OPTION) { selectedCourseId = ALL_COURSES_OPTION; return; }
            // The placeholder, back to "nothing chosen". Number('') is 0 and
            // passes Number.isInteger, so without this the panel remembers a
            // selection of course 0 — harmless only because no course has that
            // id, and because the placeholder ends up selected by being first
            // either way. State the intent rather than lean on both accidents.
            if (value === '') { selectedCourseId = null; return; }
            const parsed = Number(value);
            selectedCourseId = Number.isInteger(parsed) ? parsed : null;
          },
          onViewChange: function (next) {
            view = next;
            draw(currentPlan, saveFailed === true);
          },
          // The view emits dotted `perks.*` paths for the nested group and a
          // bare field name for the rest. An empty number input means "not
          // said" (null), which for a perk is distinct from zero.
          onSettingChange: function (field, rawValue) {
            const next = JSON.parse(JSON.stringify(settings));
            const value = typeof rawValue === 'boolean' ? rawValue
              : NUMERIC_SETTING_FIELDS.indexOf(field) === -1 ? rawValue
              : rawValue === '' ? null
              : Number(rawValue);
            if (field.indexOf('perks.') === 0) next.perks[field.slice(6)] = value;
            else next[field] = value;
            // normaliseSettings is the only writer of the canonical shape, so a
            // rejected value falls back to its default rather than being stored.
            settings = normaliseSettings(next);
            settingsSaveFailed = !saveSettings(settings);
            // Queue order is the single switch the focus nav button reads.
            // Turning it off while standing on the focus view would leave the
            // player looking at a page whose own nav entry just went dark,
            // with no route back except the settings page they came from —
            // so this falls back to schedule instead. settings.focuses is
            // left alone: this switch says which ordering applies, not what
            // the player is building toward. view is closure state, never
            // persisted, so this writes nothing to storage.
            if (field === 'orderMode' && settings.orderMode !== 'focus' && view === 'focus') view = 'schedule';
            draw(currentPlan, saveFailed === true);
          },
          // Both route through the same commit path onSettingChange uses —
          // normalise, save, redraw — so a failed write surfaces as
          // settingsSaveFailed rather than being lost, and priority stays in
          // step with settings.focuses' own array order (see
          // toggleFocus/setFocusPriority: priority IS the index).
          onFocusToggle: function (category, selection) {
            const next = JSON.parse(JSON.stringify(settings));
            next.focuses = toggleFocus(settings.focuses, category, selection);
            settings = normaliseSettings(next);
            settingsSaveFailed = !saveSettings(settings);
            draw(currentPlan, saveFailed === true);
          },
          onFocusPriority: function (category, selection, position) {
            const next = JSON.parse(JSON.stringify(settings));
            next.focuses = setFocusPriority(settings.focuses, category, selection, position);
            settings = normaliseSettings(next);
            settingsSaveFailed = !saveSettings(settings);
            draw(currentPlan, saveFailed === true);
          },
          onToggleDebugReport: function () {
            debugReport = debugReport
              ? null
              : buildDebugReport(gatherDebugContext({ fetchResult: fetchResult, plan: currentPlan, settings: settings }));
            draw(currentPlan, saveFailed === true);
          },
          onCopyDebugReport: function () {
            if (!debugReport) return;
            // Clipboard access is not granted and may be refused; the report is
            // already on screen, so a failed copy costs the player nothing.
            // writeText returns a promise and a refusal (NotAllowedError, the
            // documented reason this guard exists) rejects asynchronously —
            // try/catch alone would let it surface as an unhandledrejection on
            // Torn's own page, so the rejection is swallowed explicitly too.
            try {
              if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && navigator.clipboard.writeText) {
                const written = navigator.clipboard.writeText(debugReport);
                if (written && typeof written.then === 'function') {
                  written.then(null, function () { /* the report is visible; selecting it still works */ });
                }
              }
            } catch (e) { /* the report is visible; selecting it still works */ }
          },
          // Text from outside this browser, so nothing here trusts it: the
          // ids are checked against the live catalogue, the settings are
          // rebuilt by normaliseSettings, and a refusal is reported rather
          // than swallowed. Both writes are checked — an import that lost the
          // plan it just accepted must say so, not report success.
          onImportPlan: function (text) {
            const data = fetchResult.ok ? fetchResult.data : null;
            if (!data) { importError = 'No course data loaded, so a plan cannot be checked.'; draw(currentPlan, saveFailed === true); return; }
            const decoded = decodePlan(text, data.courses);
            if (!decoded.ok) {
              importError = `Couldn’t import that plan (${decoded.reason}: ${decoded.detail}).`;
              draw(currentPlan, saveFailed === true);
              return;
            }
            importError = null;
            settings = decoded.settings;
            settingsSaveFailed = !saveSettings(settings);
            commit({ queue: decoded.queue, collapsed: currentPlan.collapsed });
          },
        });
      } catch (e) {
        const detail = (e && e.message) || String(e);
        return renderPanel(document, mount, errorModel(`Education Scheduler hit an error and stopped: ${detail}`), noopHandlers);
      }
    }

    // renderPanel itself queries the document, so even the error path can
    // throw on a host page that is actively broken. This is the last catch
    // before the promise escapes into the bootstrap.
    try {
      if (mountError !== null) {
        return renderPanel(document, mount, errorModel(`Education Scheduler could not read the page: ${mountError}`), noopHandlers);
      }
      return draw(plan, false);
    } catch (e) {
      return null;
    }
  }

  // The guard wraps only the bootstrap, never the IIFE body. Torn Bookie's
  // harness documents the failure this avoids: if the whole body is guarded and
  // a test forgets location.search, the script early-returns, the export
  // injection never runs, and the test fails with no usable hint.
  //
  // init() is re-entrant — it holds no module state — so a route change can
  // call it again. All the state that must not be re-entered lives here, at
  // IIFE scope rather than inside init(), and is what stops the observer
  // (which fires on every DOM mutation) from turning into a request storm
  // against Torn.
  let mounted = false;     // a panel of ours belongs on the page we are on now
  let inFlight = 0;        // init() calls between their first await and their render
  let generation = 0;      // bumped on every route transition; a render from an older generation is stale
  let attempts = 0;        // mount attempts spent on the current visit to education
  let pending = null;
  // The ceiling on remounts per visit. A page we can never successfully draw
  // into would otherwise re-acquire every debounce tick, forever.
  //
  // FOR QA — the shape of this is wrong even though the number is safe. The
  // counter never decays while the player stays on education, so the realistic
  // way to exhaust it is not a pathological re-render burst: it is a long
  // dwell. A player parked on the education page while Torn reconciles
  // periodically spends the budget over an hour and then loses the panel for
  // the rest of that visit. A rate-windowed budget (N per minute) is the right
  // shape; measure the real reconciliation rate before choosing N.
  const MAX_MOUNT_ATTEMPTS = 20;

  function panelPresent() {
    return queryOne(document, '#tes-panel') !== null;
  }

  function startMount() {
    // The generation this render belongs to. init() awaits the network, and
    // the player can leave the education page while it does; a render that
    // lands after that would paste the panel — and its fixed-position fallback
    // mount — onto whatever page they are looking at now, with mounted already
    // false so nothing would ever take it away again.
    const bornAt = generation;
    inFlight += 1;
    // Deliberately re-acquired on every mount rather than cached: the old
    // mount node does not survive Torn's SPA navigation and the active
    // course's remaining time keeps moving, so a cached finish date would be
    // wrong by exactly as long as the player was away.
    init().then(function (panel) {
      inFlight -= 1;
      if (bornAt !== generation) {
        unmountPanel(document);
        scheduleSync();
        return;
      }
      // init() resolves null only when there was nowhere to draw at all.
      // Keeping mounted = true there would claim a panel that does not exist.
      // Nothing currently depends on this: syncToRoute's remount rule recovers
      // either way, and its off-education cleanup is unconditional, so no test
      // isolates this line — deleting it leaves the suite green. It is here so
      // the flag means what it says, and so the next thing to read `mounted`
      // reads the truth.
      if (!panel) mounted = false;
    }, function () {
      inFlight -= 1;
      if (bornAt === generation) mounted = false;
    });
  }

  function syncToRoute() {
    if (!isEducationPage()) {
      attempts = 0;
      if (mounted) {
        mounted = false;
        generation += 1;
      }
      // Unconditional, not gated on `mounted`: a mount that resolved with no
      // panel has already cleared the flag, and it may still have appended a
      // fallback mount to document.body before it gave up. Gating here strands
      // that div on every page the player visits next.
      unmountPanel(document);
      return;
    }

    // A mount already on its way owns the outcome; starting a second one here
    // is the request storm.
    if (inFlight > 0) return;
    // The common case by far: the observer fired for something that has
    // nothing to do with us.
    if (mounted && panelPresent()) return;
    // Either we have just arrived, or a React re-render of the container we
    // mounted into dropped our panel while the route never changed. Both are
    // fixed by mounting again — under a cap, because a page we cannot draw
    // into must fail quietly rather than loop.
    if (attempts >= MAX_MOUNT_ATTEMPTS) return;
    attempts += 1;
    generation += 1;
    mounted = true;
    // Clears a stranded fallback mount from the attempt that just lost its
    // panel, so remounting cannot stack fixed-position containers.
    unmountPanel(document);
    startMount();
  }

  function scheduleSync() {
    if (pending !== null) return;
    // A single frame's worth of coalescing: Torn's re-render fires the observer
    // many times for one navigation.
    pending = setTimeout(function () { pending = null; syncToRoute(); }, 150);
  }

  observeNavigation(document, window, { onRouteChange: scheduleSync });
  syncToRoute();
})();
