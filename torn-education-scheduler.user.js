// ==UserScript==
// @name         Torn Education Scheduler
// @namespace    https://github.com/DaftVino/torn-education-scheduler
// @version      1.2.0
// @description  TORN PDA COMPATIBLE. Plan Torn education with safe prerequisite queues, focus ordering, exact dates, degree/booster forecasts, perks, sharing, local saves, and diagnostics.
// @author       DaftVino
// @license      MIT
// @homepage     https://greasyfork.org/en/scripts/590070-torn-education-scheduler
// @supportURL   https://greasyfork.org/en/scripts/590070-torn-education-scheduler/feedback
// @match        https://www.torn.com/page.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

// @match cannot express a query string, so it is deliberately broader than the
// target page and isEducationPage() below does the real scoping. Widening
// @match or @grant beyond this needs a stated reason in the PR description.

// @license is not decoration and not a duplicate of the LICENSE file. This
// file is the whole distribution: a player installs the raw .user.js, and the
// repository — with its LICENSE, its README and its history — does not travel
// with it. Without this line the copy on someone's disk states no terms at
// all, and Greasy Fork reads this key rather than the repo to decide what it
// is allowed to host. It is kept in step with package.json and the LICENSE
// file, so the three cannot disagree about one fact.

(function () {
  'use strict';

  const SCRIPT_VERSION = '1.2.0';
  const EDU_ENDPOINT = '/page.php?sid=educationInitData';
  const FETCH_TIMEOUT_MS = 15000;
  const STORAGE_KEY = 'tes:plan';
  const SETTINGS_KEY = 'tes:settings';
  // The picker's "everything I have left" entry. A string, deliberately: it
  // shares a field with course ids, and Number('__all__') is NaN rather than a
  // plausible id, so a missed guard fails visibly instead of queueing course 0.
  const ALL_COURSES_OPTION = '__all__';
  const GUIDE_PRESETS = Object.freeze([
    Object.freeze({
      key: 'foundation', value: '__preset__:foundation', label: '0-Start Here',
      courseCodes: Object.freeze(['BIO1340', 'BIO2127']),
    }),
    Object.freeze({
      key: 'fighting', value: '__preset__:fighting', label: '1-Fighting',
      courseCodes: Object.freeze(['BIO1340', 'BIO2127', 'SPT3510']),
    }),
    Object.freeze({
      key: 'crime', value: '__preset__:crime', label: '2-Crime',
      courseCodes: Object.freeze([
        'BIO1340', 'BIO2127',
        'CMT1520', 'CMT2230', 'CMT2530', 'CMT2130', 'CMT2131',
        'PSY1630', 'PSY2640', 'PSY2650', 'PSY2660', 'PSY2670', 'PSY2680',
        'PSY2132', 'PSY3690',
      ]),
    }),
    Object.freeze({
      key: 'trader', value: '__preset__:trader', label: '3-Trader / collector',
      courseCodes: Object.freeze(['BIO1340', 'BIO2127', 'HIS3210']),
    }),
    Object.freeze({
      key: 'undecided', value: '__preset__:undecided', label: '4-Undecided',
      courseCodes: Object.freeze([
        'BIO1340', 'BIO2127',
        'DEF1700', 'DEF2740', 'DEF2750', 'DEF2760',
        'HAF1103', 'HAF2107', 'HAF2106', 'HAF2109',
        'CBT1780', 'CBT2820', 'CBT2830', 'CBT2840', 'CBT2850',
      ]),
    }),
  ]);

  // Both launch destinations are published. Keep these canonical URLs beside
  // the placeholder guard used by every renderer.
  //
  // PLACEHOLDER_TOKEN is retained as the isResolvedUrl sentinel. Any future
  // unresolved launch URL must contain the whole token; a half-edited value
  // could otherwise read as resolved.
  const PLACEHOLDER_TOKEN = 'REPLACE_BEFORE_LAUNCH';
  // Same address as @homepage above: one place to send people, not two.
  const GREASY_FORK_URL = 'https://greasyfork.org/en/scripts/590070-torn-education-scheduler';
  const FORUM_POST_URL = 'https://www.torn.com/forums.php#p=threads&f=61&t=16589908&b=0&a=0';

  // Every consumer tests this, never the constant's own truthiness: a
  // placeholder is a non-empty string, so `if (FORUM_POST_URL)` would render a
  // link to a dead address. Nothing renders until a URL is real.
  function isResolvedUrl(url) {
    return typeof url === 'string' && url.length > 0 && url.indexOf(PLACEHOLDER_TOKEN) === -1;
  }

  // ─── ENGINE START ───────────────────────────────────────────────
  // Pure functions only. No DOM, no network, no GM_*, no ambient clock.
  // Checked automatically, comments excluded — prose here may use ordinary
  // English words like window or location; code here may not touch them.

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

  // What you will have finished by the time a plan starts, rather than today:
  // the course running now ends before anything queued can begin, so for
  // judging a plan it counts as done. unmetPrerequisites answers the other
  // question — "can I start this today?" — where it correctly does not.
  //
  // Only the course activeCourse names is promoted. One marked inProgress that
  // it does not name has no completion time anywhere, so counting it would
  // print a finish date short by up to a whole course.
  function plannedCompletions(completedIds, courses, activeCourse) {
    const done = new Set(completedIds);
    if (!activeCourse || !isInt(activeCourse.id)) return done;
    const course = courses.get(activeCourse.id);
    if (course && course.status === 'inProgress') done.add(course.id);
    return done;
  }

  function guidePresetForValue(value) {
    if (typeof value !== 'string') return null;
    for (const preset of GUIDE_PRESETS) {
      if (preset.value === value) return preset;
    }
    return null;
  }

  // Resolve a guide route against today's catalogue, then return only the
  // work that must be appended after the player's existing queue. Resolution
  // happens before expansion so a stale late target cannot produce half a
  // route. The caller owns storage; this helper mutates none of its inputs.
  function expandGuidePreset(presetKey, completedIds, courses, activeCourse, existingQueue) {
    let preset = null;
    for (const candidate of GUIDE_PRESETS) {
      if (candidate.key === presetKey) { preset = candidate; break; }
    }
    if (!preset) {
      return { ok: false, reason: 'unknown-preset', detail: `Unknown guide preset ${String(presetKey)}` };
    }
    if (!(courses instanceof Map)) {
      return { ok: false, reason: 'invalid-catalogue', detail: 'No course catalogue is available' };
    }

    const byCode = new Map();
    for (const course of courses.values()) {
      if (course && typeof course.prefix === 'string') byCode.set(course.prefix, course);
    }
    const targets = [];
    for (const code of preset.courseCodes) {
      const course = byCode.get(code);
      if (!course) {
        return { ok: false, reason: 'missing-course', detail: `${code} is not in Torn's course catalogue` };
      }
      targets.push(course);
    }

    const done = plannedCompletions(completedIds instanceof Set ? completedIds : new Set(), courses, activeCourse);
    for (const id of Array.isArray(existingQueue) ? existingQueue : []) {
      const course = courses.get(id);
      if (course && course.status !== 'inProgress') done.add(id);
    }
    const plannedDone = new Set(done);
    const courseIds = [];
    for (const target of targets) {
      for (const id of requiredCoursesFor(target.id, done, courses)) {
        if (done.has(id)) continue;
        const course = courses.get(id);
        if (!course) continue;
        if (course.status === 'completed') { done.add(id); continue; }
        if (course.status === 'inProgress') continue;
        courseIds.push(id);
        done.add(id);
      }
    }

    const problems = validateQueue(courseIds, plannedDone, courses);
    if (problems.length > 0) {
      const first = problems[0];
      const course = courses.get(first.courseId);
      return {
        ok: false,
        reason: 'unfollowable-preset',
        detail: `${course ? course.prefix : first.courseId} has unavailable prerequisites`,
      };
    }
    return { ok: true, courseIds: courseIds };
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

  // One click crosses exactly one neighbouring course, so movement permission
  // is one graph question rather than a full queue re-validation per button.
  // upstreamOf is the same composed prerequisite graph orderQueue uses: direct
  // parents, transitive ancestors, and the tier-3 bachelor rule all count.
  // A caller may share `cache` across every row so an all-courses queue does
  // not walk the same catalogue hundreds of times while building its model.
  function canMoveQueueCourse(queue, courseId, direction, courses, cache) {
    if (direction !== 'up' && direction !== 'down') {
      return { allowed: false, reason: 'invalid-direction', blockingCourseId: null };
    }
    if (!Array.isArray(queue) || !(courses instanceof Map)) {
      return { allowed: false, reason: 'invalid-input', blockingCourseId: null };
    }
    const index = queue.indexOf(courseId);
    if (index === -1) return { allowed: false, reason: 'missing-course', blockingCourseId: null };
    const target = index + (direction === 'up' ? -1 : 1);
    if (target < 0 || target >= queue.length) {
      return { allowed: false, reason: 'boundary', blockingCourseId: null };
    }

    const crossedId = queue[target];
    const scratch = cache || new Map();
    // Moving up is illegal when the moving course needs the course it would
    // cross. Moving down is the mirror: the crossed course needs the moving
    // course and would be left ahead of its prerequisite.
    const blocked = direction === 'up'
      ? upstreamOf(courseId, courses, scratch).has(crossedId)
      : upstreamOf(crossedId, courses, scratch).has(courseId);
    return blocked
      ? { allowed: false, reason: 'prerequisite', blockingCourseId: crossedId }
      : { allowed: true, reason: null, blockingCourseId: null };
  }

  function moveQueueCourse(queue, courseId, direction, courses, cache) {
    const copy = Array.isArray(queue) ? queue.slice() : [];
    const permission = canMoveQueueCourse(queue, courseId, direction, courses, cache);
    if (!permission.allowed) {
      return {
        ok: false, reason: permission.reason,
        blockingCourseId: permission.blockingCourseId, queue: copy,
      };
    }
    const index = copy.indexOf(courseId);
    const target = index + (direction === 'up' ? -1 : 1);
    const crossed = copy[target];
    copy[target] = courseId;
    copy[index] = crossed;
    return { ok: true, reason: null, blockingCourseId: null, queue: copy };
  }

  // Ordering does NOT change the finish date. Courses run one at a time, so
  // the total is a sum, and a sum does not care about order. What ordering
  // changes is time-to-benefit: how early each perk starts paying off. Several
  // community guides blur the two. This must not.
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
  // One source for both the stored vocabulary and the Focus-view button copy.
  // The button states what is active, so the ordering is readable before the
  // player clicks it.
  const FOCUS_RANK_BASIS_LABELS = [
    { id: 'per-day', label: 'most per day' },
    { id: 'total', label: 'biggest total' },
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

  // These rows multiply a future rate of gain, so taking them early lets them
  // compound over work still ahead. A passive stat percentage is deliberately
  // absent: it is a one-off percentage of stats already held, not a multiplier
  // on future earning. Combat bonuses are one-off effects for the same reason.
  const BALANCED_GAIN_MULTIPLIER_KEYS = Object.freeze([
    'Gym Gain Bonus Defense',
    'Gym Gain Bonus Dexterity',
    'Gym Gain Bonus Speed',
    'Gym Gain Bonus Strength',
    'General Progression Bonuses Education Working Stat Rewards',
    'Crime & Jail Bonuses Crime Experience Gain',
    'Crime & Jail Bonuses Crime Skill Progression',
  ]);

  // Higher sorts earlier — orderQueue negates, so this is the same convention
  // focusScores uses. A separate rank per group rather than an offset added to
  // the score: see balancedScores' return for why an offset cannot work here.
  const BALANCED_GROUP_RANKS = Object.freeze([2, 1, 0]);
  const EDUCATION_WORKING_STAT_REWARDS_KEY =
    'General Progression Bonuses Education Working Stat Rewards';

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

  // The fresh-install order: gain multipliers, then quantified benefits, then
  // unlocks. Contributions are normalised per type before they are summed, so a
  // benefit that happens to use large numbers cannot outrank a different kind.
  //
  // Returns a VECTOR of two maps — [group, score] — compared lexicographically,
  // never one combined number. Folding the group into the score as an offset
  // fails silently: orderQueue divides by duration, the offset divides with it,
  // and the offset term dwarfs the score by six orders of magnitude — leaving
  // shortest-first wearing a scoring feature's clothes.
  //
  // `basis` is applied here, to the score element only, since a group is not a
  // rate. Callers therefore ask orderQueue for 'total' so it does not divide
  // a second time.
  function balancedScores(courses, completedIds, basis) {
    const map = (courses instanceof Map) ? courses : new Map();
    const done = (completedIds instanceof Set) ? completedIds : new Set();
    const registry = focusRegistry(map);
    const rowsByCourse = new Map();
    for (const row of registry.entries) {
      if (!rowsByCourse.has(row.courseId)) rowsByCourse.set(row.courseId, []);
      rowsByCourse.get(row.courseId).push(row);
    }

    let completedWorkingStats = 0;
    for (const id of done) {
      for (const n of workingStatsFor(map.get(id)).values()) completedWorkingStats += n;
    }

    // courseId -> (type key -> summed value). Summing here means a course
    // reached twice under one type is still one contribution from one course,
    // matching focusTotals' course-level dedupe rather than double-counting it.
    const byCourse = new Map();
    function addContribution(courseId, type, value) {
      if (!Number.isFinite(value) || value < 0) return;
      if (!byCourse.has(courseId)) byCourse.set(courseId, new Map());
      const contributions = byCourse.get(courseId);
      contributions.set(type, (contributions.get(type) || 0) + value);
    }

    for (const course of map.values()) {
      for (const [stat, value] of workingStatsFor(course)) {
        addContribution(course.id, `stat:${stat}`, value);
      }
    }

    for (const row of registry.entries) {
      if (!Number.isFinite(row.magnitude)) continue;
      const type = focusKey(row.category, row.selection);
      let value = row.magnitude;
      if (type === EDUCATION_WORKING_STAT_REWARDS_KEY) {
        // This is the one percentage whose base exists in the payload: working
        // stats already earned from completed educations. Ten percent of that
        // total is the best available approximation of future education gains.
        value = completedWorkingStats * (row.magnitude / 100);
      } else if (row.unit === 'percent') {
        // No base exists in this payload for any other percentage — no battle
        // stats, company figures, jail record or crime stats. Its normalised
        // magnitude below is only a rank hint, not an absolute quantity;
        // inventing a base would repeat the summed-exchange-rate error. In
        // particular, this code never guesses the player's strength.
      }
      addContribution(row.courseId, type, value);
    }

    const maxForType = new Map();
    for (const contributions of byCourse.values()) {
      for (const [type, value] of contributions) {
        const old = maxForType.get(type);
        if (old === undefined || value > old) maxForType.set(type, value);
      }
    }

    const groups = new Map();
    const scores = new Map();
    for (const course of map.values()) {
      const rows = rowsByCourse.get(course.id) || [];
      const multiplier = rows.some(function (row) {
        return BALANCED_GAIN_MULTIPLIER_KEYS.indexOf(focusKey(row.category, row.selection)) !== -1;
      });
      const contributions = byCourse.get(course.id) || new Map();
      const group = multiplier ? 0 : contributions.size > 0 ? 1 : 2;
      let normalised = 0;
      for (const [type, value] of contributions) {
        const maximum = maxForType.get(type) || 0;
        if (maximum > 0) normalised += value / maximum;
      }
      // Same guard orderQueue uses on a malformed catalogue: an absent or zero
      // duration becomes one day rather than leaking NaN/Infinity into a
      // comparator.
      const durationDays = (Number.isFinite(course.duration) && course.duration > 0)
        ? course.duration / 86400
        : 1;
      groups.set(course.id, BALANCED_GROUP_RANKS[group]);
      scores.set(course.id, basis === 'total' ? normalised : normalised / durationDays);
    }
    return [groups, scores];
  }

  // What a course actually gives, from the two payload fields that say so.
  // Never inferred from a name: 31 of 131 courses list no outcome at all, and
  // "Bonus: not listed by Torn" is the honest answer for them — the same
  // trade the panel makes with a withheld finish date rather than a guessed
  // one.
  function bonusLabel(course) {
    const stats = workingStatsFor(course);
    const parts = [];
    for (const [stat, n] of stats) parts.push(`${n} ${stat}`);
    const outcomes = (course && Array.isArray(course.learningOutcomes)) ? course.learningOutcomes : [];
    for (const o of outcomes) if (typeof o === 'string') parts.push(o);
    if (parts.length === 0) return 'Bonus: not listed by Torn';
    if (outcomes.length === 0) return `${parts.join(', ')} · other bonus not listed by Torn`;
    return parts.join(' · ');
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
    const byKey = new Map(), countKeys = new Set();
    for (const row of reg.entries) {
      const k = focusKey(row.category, row.selection);
      if (row.unit === 'none' || FOCUS_UNSTATABLE.indexOf(row.selection) !== -1) countKeys.add(k);
      if (!byKey.has(k)) byKey.set(k, new Map());
      const scores = byKey.get(k);
      // Number.isFinite deliberately does not coerce null: unlock rows have no
      // magnitude, and each one still means one course worth routing toward.
      const n = (row.unit === 'none' || !Number.isFinite(row.magnitude)) ? 1 : row.magnitude;
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
      const k = focusKey(category, selection);
      const scores = byKey.get(k) || new Map();
      return countKeys.has(k) ? propagateFocusScore(scores) : new Map(scores);
    });
    // Count focuses are routing requests. Magnitude focuses are accumulation
    // requests: Kahn readiness already puts gates before dependants, and routing
    // would only prioritize zero-gain gates over unrelated real gainers. Use the
    // same closure as orderQueue, and maximum so a shared gate cannot outrank its target.
    function propagateFocusScore(scores) {
      const routed = new Map(scores);
      const upstream = new Map();
      for (const [courseId, score] of scores) {
        for (const ancestorId of upstreamOf(courseId, map, upstream)) {
          const inherited = routed.get(ancestorId) || 0;
          if (score > inherited) routed.set(ancestorId, score);
        }
      }
      return routed;
    }
  }

  // Selections whose catalogue total cannot honestly be stated. Each is a
  // property of Torn's own wording, recorded here rather than inferred:
  // weapon experience has no ceiling, overclocking values are successive
  // limits rather than additive bonuses, and a "further" bonus may be
  // cumulative in a way its magnitude alone does not say.
  const FOCUS_UNSTATABLE = Object.freeze(['Weapon Experience Damage', 'Weapon Experience Accuracy', 'Rig Overclocking Limit']);
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
      byCourse.set(r.courseId, (byCourse.get(r.courseId) || 0) + (Number.isFinite(r.magnitude) ? r.magnitude : 0));
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

  // What a queued path delivers, per (category, selection) and never summed
  // across them: the same rule focusTotals and focusScores keep. Each figure
  // is focusTotals' own `remaining` with every course OUTSIDE the queue
  // treated as banked, so the unit rule and FOCUS_UNSTATABLE are focusTotals'
  // rather than a second copy of them. Within a category, units are grouped
  // (percent, flat, count) and never ranked against each other.
  // `unmatched` is this path's own data health: taxonomy rows on queued
  // courses whose outcome text Torn no longer shows, plus outcome strings on
  // queued courses the taxonomy never claimed. A catalogue-wide figure would
  // warn a plan about courses it does not contain.
  // FOCUS_CATEGORIES is declared further down; it is read only when this
  // runs, long after the IIFE has initialised.
  const PATH_GAIN_UNIT_RANK = Object.freeze({ percent: 0, flat: 1, count: 2 });
  function pathGains(queue, courses) {
    const map = (courses instanceof Map) ? courses : new Map();
    const ids = Array.isArray(queue)
      ? queue.filter(function (id, i, a) { return map.has(id) && a.indexOf(id) === i; })
      : [];
    const out = { courseCount: ids.length, degreeCount: 0, workingStats: [], categories: [], unmatched: 0 };
    if (ids.length === 0) return out;

    const queued = new Set(ids);
    const notQueued = new Set();
    for (const id of map.keys()) if (!queued.has(id)) notQueued.add(id);

    out.degreeCount = ids.filter(function (id) { return map.get(id).tier === 3; }).length;

    for (const stat of WORKING_STATS) {
      const t = focusTotals({ category: FOCUS_WORKING_STATS, selection: stat }, map, notQueued);
      if (t.remaining > 0) out.workingStats.push({ stat: stat, amount: t.remaining });
    }

    for (const category of FOCUS_CATEGORIES) {
      if (category === FOCUS_WORKING_STATS) continue;
      const selections = FOCUS_TAXONOMY
        .filter(function (r) { return r.category === category; })
        .map(function (r) { return r.selection; })
        .filter(function (s, i, a) { return a.indexOf(s) === i; });
      const gains = [];
      for (const selection of selections) {
        const t = focusTotals({ category: category, selection: selection }, map, notQueued);
        if (t.remaining > 0) gains.push({ selection: selection, unit: t.unit, amount: t.remaining });
      }
      if (gains.length === 0) continue;
      gains.sort(function (a, b) {
        const ra = PATH_GAIN_UNIT_RANK[a.unit];
        const rb = PATH_GAIN_UNIT_RANK[b.unit];
        if (ra !== rb) return ra - rb;
        if (a.unit !== 'count' && a.amount !== b.amount) return b.amount - a.amount;
        return a.selection < b.selection ? -1 : a.selection > b.selection ? 1 : 0;
      });
      out.categories.push({ category: category, gains: gains });
    }

    for (const row of FOCUS_TAXONOMY) {
      if (!queued.has(row.courseId)) continue;
      const outcomes = map.get(row.courseId).learningOutcomes;
      if (!Array.isArray(outcomes) || outcomes.indexOf(row.outcome) === -1) out.unmatched += 1;
    }
    for (const id of ids) {
      const outcomes = map.get(id).learningOutcomes;
      if (!Array.isArray(outcomes)) continue;
      for (const o of outcomes) {
        const claimed = FOCUS_TAXONOMY.some(function (r) { return r.courseId === id && r.outcome === o; });
        if (!claimed) out.unmatched += 1;
      }
    }
    return out;
  }

  // Everything that must be done before this course can be: the parentId chain,
  // plus the rule the payload does not carry — a tier-3 bachelor requires every
  // tier-2 course in its own category. The two compose, which is why this is one
  // closure rather than two checks: a tier-1 root reaches its own bachelor only
  // through the tier-2 courses between them.
  //
  // `cache` is optional scratch so a caller asking about many courses walks each
  // chain once. It is keyed by course id alone, so one cache belongs to one
  // catalogue; and a cache hit returns the stored Set itself, so callers must
  // read it and never write to it.
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
  function orderQueue(queue, mode, courses, scoreMaps, focusRankBasis) {
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
    // The fifth argument was added after focus ordering shipped. Omitting it
    // must preserve that shipped most-per-day behaviour for every caller.
    const basis = FOCUS_RANK_BASES.indexOf(focusRankBasis) !== -1
      ? focusRankBasis
      : 'per-day';

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
        const course = courses.get(id);
        // Treat an absent or zero duration as one day: a malformed catalogue
        // must keep a finite, useful rank instead of leaking NaN/Infinity into
        // the comparator, while scored courses still sort ahead of zeroes.
        const durationDays = (course && Number.isFinite(course.duration) && course.duration > 0)
          ? course.duration / 86400
          : 1;
        rankVector.set(id, maps.map(function (m) {
          const score = (m instanceof Map && Number.isFinite(m.get(id))) ? m.get(id) : 0;
          return basis === 'total' ? -score : -(score / durationDays);
        }));
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
        // all score the same comes back exactly as it went in. Not a hedge
        // against sort stability, which is guaranteed: `ready` arriving in queue
        // order holds only while `remaining` is an array, and a refactor to a
        // Set would break it silently.
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
  // orderQueue.
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
  // The boxes DO sum to the all-courses box today, in both course count and
  // seconds: no course has a parentId outside its own category, and a tier-3
  // bachelor gates only on tier-2 courses in its own, so the twelve categories
  // partition the catalogue exactly.
  //
  // sumsDiffer is kept anyway and is false today, because that is a property of
  // Torn's catalogue rather than of this code. If a prerequisite ever does
  // cross a category, the UI has to say why before someone adds the boxes up,
  // gets a bigger number and concludes the tool is broken.
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
    const allBox = boxFor('all', 'all remaining courses', null, everything);

    return { boxes: boxes, allBox: allBox, sumsDiffer: summedCount > allBox.courseCount };
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
  const FOCUS_RANK_BASES = FOCUS_RANK_BASIS_LABELS.map(function (b) { return b.id; });
  const SETTINGS_DEFAULTS = {
    maxCooldownHours: 48,
    booksOwned: 0,
    bookPrice: 13500000,
    jobPoints: 0,
    // Focus is the default so its view is available out of the box. With no
    // focuses selected, focus ordering deliberately degrades to as-listed,
    // so a fresh install's queue is unchanged; only the nav entry appears.
    orderMode: 'focus',
    focusRankBasis: 'per-day',
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
      focusRankBasis: FOCUS_RANK_BASES.indexOf(source.focusRankBasis) !== -1
        ? source.focusRankBasis
        : SETTINGS_DEFAULTS.focusRankBasis,
      focuses: normaliseFocuses(source.focuses),
    };
  }

  // Everything the settings page owns, back to default — and focuses left
  // exactly as they were. Focuses live in this object for storage reasons, not
  // because the settings page owns them; the focus view has its own control.
  // Written as an explicit carry rather than a spread of the old object so that
  // a field added later defaults rather than silently surviving a reset.
  function settingsDefaults(current) {
    const fresh = normaliseSettings(null);
    fresh.focuses = normaliseSettings(current).focuses;
    return fresh;
  }

  const SECONDS_PER_BOOK = 21600;       // a Book of Carols removes 6 hours of course time
  const BOOK_COOLDOWN_SECONDS = 21600;  // and adds 6 hours of booster cooldown
  // Derived, not asserted: the divisor in the closed form below IS the sum of
  // the two, and writing 43200 with a "6 + 6" comment beside it would leave the
  // relationship described rather than enforced.
  const BOOK_FIXED_POINT_SECONDS = SECONDS_PER_BOOK + BOOK_COOLDOWN_SECONDS;
  // A job point buys 30 minutes off a course. Spent per course in the game,
  // but the panel is costing a whole path, and over a path the only thing
  // that matters is the total: N points remove N × 30 minutes from it.
  //
  // Unlike a Book, a point carries no cooldown, so there is no fixed point to
  // solve and no ceiling beyond the path itself.
  const SECONDS_PER_JOB_POINT = 1800;

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
  //
  // Job points are applied before either, and the ordering is load-bearing
  // rather than cosmetic — see the comment on `boosted` below.
  function planConsumables(options) {
    const opts = options || {};
    const base = isInt(opts.baseSeconds) && opts.baseSeconds >= 0 ? opts.baseSeconds : 0;
    const owned = isInt(opts.booksOwned) && opts.booksOwned >= 0 ? opts.booksOwned : 0;
    const price = isInt(opts.bookPrice) && opts.bookPrice >= 0 ? opts.bookPrice : 0;
    const points = isInt(opts.jobPoints) && opts.jobPoints >= 0 ? opts.jobPoints : 0;

    // Clamped to the path, exactly as every Book saving below is: a player
    // holding more points than they have queued time cannot drive the path
    // past zero.
    const jobPointSaving = Math.min(points * SECONDS_PER_JOB_POINT, base);
    // The points the saving actually costs, never the points the player holds.
    // Same distinction plannedBooks draws below and for the same reason: a
    // clamped saving quoted beside an unclamped count describes nothing.
    // Math.ceil, because a half-spent point is spent.
    const jobPointsUsed = Math.ceil(jobPointSaving / SECONDS_PER_JOB_POINT);
    // Every Book figure below is computed against THIS, not against `base`.
    // The ordering is not presentational: `ceiling` is a function of the path
    // length, so points shorten the path AND lower the number of Books it can
    // absorb. Costing the Books first would price a ceiling for a path that
    // no longer exists — the same class of error as pricing the floor at the
    // cooldown ceiling, which this function already refuses to do.
    const boosted = base - jobPointSaving;

    const ceiling = booksCeiling({ baseSeconds: boosted, maxCooldownSeconds: opts.maxCooldownSeconds });

    const usable = Math.min(owned, ceiling);
    const plannedSaving = Math.min(usable * SECONDS_PER_BOOK, boosted);
    const floorSaving = Math.min(ceiling * SECONDS_PER_BOOK, boosted);

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
      // Points, then the path they leave behind for the Books to work on.
      // jobPointSeconds is what every figure below was computed against, so a
      // consumer that wants to show the ordering has the intermediate value
      // rather than having to re-derive it from a saving.
      jobPoints: jobPointsUsed,
      jobPointSaving: jobPointSaving,
      jobPointSeconds: boosted,
      ceiling: ceiling,
      plannedBooks: plannedBooks,
      plannedSaving: plannedSaving,
      plannedSeconds: boosted - plannedSaving,
      floorBooks: floorBooks,
      floorSaving: floorSaving,
      floorSeconds: boosted - floorSaving,
      floorCost: floorBooks * price,
      // A price of zero is not a price. Typing 0 survives normalisation, and
      // the sentence it would produce — "the floor costs $0" — is the most
      // misleading thing this feature could say. Clearing the field does not
      // reach 0; it restores the default. So the reachable path is a typed
      // zero, and only that.
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
      `  Focus rank basis: ${show(settings && settings.focusRankBasis)}`,
      '',
      'Queue',
      `  Length: ${show(src.queueLength)}`,
      // Joined with a space, not a comma, so no run of ids can be mistaken
      // for the completed-course set this report deliberately withholds.
      `  Courses: ${Array.isArray(src.queueCodes) && src.queueCodes.length > 0 ? src.queueCodes.join(' ') : 'none'}`,
      '',
      // Counts only, straight off focusRegistry and settings.focuses' own
      // length — never a selection's course list, never an outcome string.
      'Focus',
      `  Stale classifications: ${show(src.focusStale)}`,
      `  Unmapped outcomes: ${show(src.focusUnmapped)}`,
      `  Selections made: ${show(src.focusSelections)}`,
      '',
      // GREASY_FORK_URL's one consumer. Named in prose either way, because
      // the instruction is useful without the URL; the URL is appended only
      // once it exists, so resolving it has a visible effect here and a test
      // that fails if it is set without the report being re-checked.
      isResolvedUrl(GREASY_FORK_URL)
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
      `r=${s.focusRankBasis === 'total' ? 't' : 'p'}`,
    ];
    if (s.focuses.length > 0) {
      parts.push(`f=${s.focuses.map(function (f) { return `${f.category}${f.selection}`; }).join(',')}`);
    }
    if (s.perks.meritsPercent !== null) parts.push(`m=${s.perks.meritsPercent}`);
    if (s.perks.principal !== null) parts.push(`pr=${s.perks.principal ? 1 : 0}`);
    if (s.perks.wsuBlock !== null) parts.push(`w=${s.perks.wsuBlock ? 1 : 0}`);
    return parts.join('|');
  }

  // The only part of a pasted share string quoted back on screen, so the only
  // part needing sizing and sanitising. 40 characters is enough to find the
  // offending token and not enough to be a wall of text.
  //
  // The character replacement is not decoration: a bidi override (U+202E) inside
  // the quoted token reverses the display of the rest of its line, so an error
  // message can be made to read as something else entirely. Every character
  // stripped here is invisible anyway, so removing it costs the reader nothing.
  const MAX_TOKEN_CHARS = 40;
  const UNPRINTABLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;
  function quoteToken(token) {
    const safe = token.replace(UNPRINTABLE, '\uFFFD');
    return safe.length <= MAX_TOKEN_CHARS
      ? `"${safe}"`
      : `"${safe.slice(0, MAX_TOKEN_CHARS)}…" (truncated, ${safe.length} chars)`;
  }

  // encodePlan concatenates category and selection with no separator between
  // them (see its comment above the `f=` push), so the only way back is to
  // match a token against every known (category, selection) pair — the same
  // set normaliseFocuses validates against — and split there. Built once from
  // fixed data; a token that matches no pair maps to a sentinel {category:
  // null, ...} that normaliseFocuses is guaranteed to drop, which is what lets
  // decodePlan detect the loss below rather than silently swallow it.
  const FOCUS_CONCAT_INDEX = (function () {
    const map = new Map();
    for (const row of FOCUS_TAXONOMY) {
      map.set(`${row.category}${row.selection}`, { category: row.category, selection: row.selection });
    }
    for (const stat of WORKING_STATS) {
      map.set(`${FOCUS_WORKING_STATS}${stat}`, { category: FOCUS_WORKING_STATS, selection: stat });
    }
    return map;
  }());

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

    // A field that parses (a comma-separated list of tokens) but loses
    // entries once run through normaliseFocuses — an unrecognised token, or a
    // second selection in a category already claimed — is a refusal, not a
    // silent drop: matching how an unknown course id above refuses by name
    // rather than dropping the id and keeping the rest of the queue.
    const rawFocus = typeof fields.f === 'string' ? fields.f : '';
    const focusTokens = rawFocus.length > 0 ? rawFocus.split(',') : [];
    let firstBadFocusToken = null;
    const focusCandidates = focusTokens.map(function (token) {
      const match = FOCUS_CONCAT_INDEX.get(token);
      if (!match && firstBadFocusToken === null) firstBadFocusToken = token;
      return match || { category: null, selection: null };
    });

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
      focusRankBasis: fields.r === 't' ? 'total' : fields.r === 'p' ? 'per-day' : fields.r,
      focuses: focusCandidates,
      perks: {
        meritsPercent: toInt(fields.m),
        principal: toBool(fields.pr),
        wsuBlock: toBool(fields.w),
      },
    });

    if (settings.focuses.length !== focusCandidates.length) {
      return {
        ok: false,
        reason: 'unknown-focus',
        detail: firstBadFocusToken !== null
          ? `${quoteToken(firstBadFocusToken)} is not a focus selection`
          : 'a focus selection conflicts with another and cannot be kept',
      };
    }

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
  async function fetchEducationData(fetchImpl, cookieString, timeoutMs) {
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

    const request = Promise.resolve().then(async function () {
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
    });

    // Embedded webviews can leave a same-origin request pending indefinitely.
    // Race the whole exchange, including body reading and parsing, so the
    // existing React-fiber fallback gets a chance to answer. The rejection arm
    // is attached before the race: an eventual late rejection is consumed and
    // cannot surface as an unhandled rejection on Torn's page.
    const limit = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : FETCH_TIMEOUT_MS;
    let timeoutId = null;
    const settledRequest = request.then(
      function (value) { return { type: 'result', value: value }; },
      function (error) { return { type: 'error', error: error }; }
    );
    const timeout = new Promise(function (resolve) {
      timeoutId = setTimeout(function () { resolve({ type: 'timeout' }); }, limit);
    });
    const outcome = await Promise.race([settledRequest, timeout]);
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (outcome.type === 'timeout') {
      return { ok: false, reason: 'timeout', detail: 'education data request timed out' };
    }
    if (outcome.type === 'error') {
      const e = outcome.error;
      return { ok: false, reason: 'network', detail: String(e && e.message ? e.message : e) };
    }
    return outcome.value;
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
    try {
      if (typeof location === 'undefined'
        || location.hostname !== 'www.torn.com'
        || location.pathname !== '/page.php') return false;
      const params = new URLSearchParams(location.search || '');
      return params.get('sid') === 'education';
    } catch (e) {
      return false;
    }
  }

  // Torn City Time is UTC+0, so these are the UTC getters and the instant is
  // unchanged from the old toUTCString(). What changed is that the date and the
  // time are separate values and the label says TCT — which is what the rest of
  // the player's screen says while they read this.
  //
  // NEVER the local getters. A player on UTC+10 reading a bare local 21:00
  // would be eleven hours wrong about when to log in, and the bug is invisible
  // on any machine already set to UTC, so it is checked under a non-UTC zone.
  function pad2(n) { return n < 10 ? `0${n}` : String(n); }

  function formatDate(seconds) {
    const d = new Date(seconds * 1000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }

  // No seconds: a finish estimate derived from course durations is not accurate
  // to the second, and a ":00" that never varies claims precision it lacks.
  function formatTime(seconds) {
    const d = new Date(seconds * 1000);
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  }

  // Abbreviation rule:
  // abbreviate in dense readouts where the word sits beside a number and
  // space is scarce — "6 crs", "84 days", "12 hrs" (the grid cell, the
  // queue row, this function). Keep the full word in prose, where it reads
  // as a sentence rather than a measurement — the picker's own
  // `— all remaining courses (115) —` at ~2980 is the deliberate exception:
  // "all remaining crs (115)" reads badly in a full-width dropdown with no
  // space pressure, and the all-remaining banner (a later task in this
  // plan) titles itself "all remaining courses" too, so the picker matches
  // the banner rather than the grid.
  function formatDuration(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const parts = [];
    if (days > 0) parts.push(days === 1 ? '1 day' : `${days} days`);
    if (hours > 0) parts.push(`${hours} hrs`);
    if (parts.length === 0) return '0 hrs';
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

  // Why the summary toggle is disabled, one string per cause, so a failed
  // fetch is never described as a problem with the player's queue.
  const PATH_SUMMARY_REASONS = Object.freeze({
    noData: 'No course data loaded, so there is no path to summarise.',
    empty: 'Queue a course to see a path summary.',
    prerequisites: 'This queue has unmet prerequisites, so it has no finish date to summarise.',
  });

  // The summary toggle's text, built here so the renderer only places strings.
  // Every figure is one (category, selection) or one stat; nothing is summed
  // across them, for the reason pathGains gives. No Books floor date: a floor
  // without its Book count and cost is a number nobody can act on, and the
  // booster block directly below already shows it with both.
  const PATH_SUMMARY_ITEMS_PER_LINE = 4;
  function pathSummaryModel(gains, labels) {
    const num = function (n) { return Number(n.toFixed(2)).toLocaleString('en-US'); };
    const plural = function (n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; };
    const head = [plural(gains.courseCount, 'course')];
    if (gains.degreeCount > 0) head.push(plural(gains.degreeCount, 'degree'));
    // "queued": the finish date also waits for the active course, so a bare
    // duration beside it would read as wrong.
    head.push(`${labels.totalLabel} queued`);

    const workingStats = gains.workingStats.length === 0 ? null
      : 'Working stats: ' + gains.workingStats.map(function (w) { return `+${num(w.amount)} ${w.stat}`; }).join(' · ');

    const categories = gains.categories.map(function (c) {
      const items = c.gains.map(function (g) {
        if (g.unit === 'percent') return `${g.selection} +${num(g.amount)}%`;
        if (g.unit === 'flat') return `${g.selection} +${num(g.amount)}`;
        return g.selection;
      });
      if (items.length <= PATH_SUMMARY_ITEMS_PER_LINE) {
        return { text: `${c.category}: ${items.join(' · ')}`, fullText: null };
      }
      const shown = items.slice(0, PATH_SUMMARY_ITEMS_PER_LINE);
      return {
        text: `${c.category}: ${shown.join(' · ')} · +${items.length - shown.length} more`,
        fullText: `${c.category}: ${items.join(' · ')}`,
      };
    });

    const healthNote = gains.unmatched > 0
      ? "Some of these courses' bonuses could not be matched to Torn's current text and are not counted."
      : null;

    return { headline: head.join(' · '), finish: `Finishes ${labels.finishLabel}`,
      workingStats: workingStats, categories: categories, healthNote: healthNote };
  }

  function buildPanelModel(state) {
    // Computed once, here, so nothing downstream depends on the caller having
    // normalised: panelSettings runs normaliseSettings, which turns anything —
    // including undefined — into the documented defaults.
    const settings = panelSettings(state);
    const empty = {
      status: 'error', message: null, reductionLabel: null,
      queue: [], addable: [], guidePresets: [], stale: [], problems: [], finishLabel: null, totalLabel: null,
      collapsed: state.plan.collapsed === true,
      saveError: state.saveFailed === true,
      presetError: state.presetError || null,
      queueNotice: state.queueNotice || null,
      selectedCourseId: state.selectedCourseId != null ? state.selectedCourseId : null,
      view: state.view || 'schedule',
      // Lives in init()'s closure, never in storage — see resetButton. Read
      // once per draw like every other flag on this model; false here means
      // a fetch failure never reaches the panel with an armed reset control.
      resetArmed: state.resetArmed === true,
      settings: settings,
      settingsSaveError: state.settingsSaveFailed === true,
      perkInference: NO_INFERENCE,
      // No payload means no total to reduce, so there is no floor date to
      // quote — and a floor date is the one thing that must never be guessed.
      consumables: null,
      summaryAvailable: false, summaryReason: PATH_SUMMARY_REASONS.noData, summaryOpen: false, pathSummary: null,
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
      focusOpenCategories: [],
      focusOpenCompletedCategories: [],
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
    // The scores the player asked for, handed to the sort that uses them.
    // orderQueue treats a missing fourth argument as "no focus", which is why
    // omitting this made 'My focus first' silently behave as 'as-listed'.
    // Computed only in focus mode: focusScores walks the registry, and the
    // other three modes have no use for the result.
    const balanced = settings.orderMode === 'focus' && settings.focuses.length === 0;
    const scoreMaps = settings.orderMode === 'focus'
      ? (balanced
        ? balancedScores(data.courses, data.completedIds, settings.focusRankBasis)
        : focusScores(settings.focuses, data.courses))
      : null;
    // balancedScores has already applied the basis to its score element, and
    // its group element is a rank rather than a rate — so orderQueue must be
    // told 'total' here, or it divides both by duration a second time and the
    // group stops being a group. See balancedScores' own note.
    const rankBasis = balanced ? 'total' : settings.focusRankBasis;
    // The player's chosen ordering is applied once, here, and everything
    // downstream — schedule, validateQueue, finishById, the rendered rows —
    // reads the ordered queue. It cannot move the finish date (a sum does not
    // care about order); it moves which course finishes when, which is the
    // whole point of offering the choice.
    const queue = orderQueue(prunedQueue, settings.orderMode, data.courses, scoreMaps, rankBasis);
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
      // Tier-3 courses unlock things and gate on an entire degree, so they
      // have to stand out among ~115 entries. Carried here as `isBachelor`
      // only — the picker renderer turns it into a `.tes-option-bachelor`
      // class rather than a text prefix (owner decision: see the CSS rule in
      // injectStyleOnce/panelStyleText for why, and why there is no fallback).
      const isBachelor = course.tier === 3;
      addable.push({
        courseId: course.id,
        prefix: course.prefix,
        name: course.name,
        isBachelor: isBachelor,
        durationLabel: formatDuration(course.duration),
        label: `${course.prefix} ${course.name} (${formatDuration(course.duration)})`,
      });
    }
    addable.sort(function (a, b) { return a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0; });

    const guidePresets = GUIDE_PRESETS.flatMap(function (preset) {
      const expansion = expandGuidePreset(
        preset.key, data.completedIds, data.courses, data.activeCourse, prunedQueue
      );
      if (expansion.ok && expansion.courseIds.length === 0) return [];
      // A broken definition remains selectable so the add handler can name
      // the stale course instead of turning a data error into a hidden row.
      return [{
        key: preset.key,
        value: preset.value,
        label: preset.label,
      }];
    });

    // Never present a guess as a reading. The note says in words which of the
    // two situations the player is in, so a prefilled field is visibly an
    // inference they are invited to correct rather than a value we read off
    // their account.
    // The grid is independent of the player's queue: each box starts from now
    // and answers its own question. Labels are built here rather than in the
    // view, because formatDuration/formatDate/formatTime are runtime while
    // buildDegreeGrid is engine.
    const rawGrid = buildDegreeGrid({
      courses: data.courses, categories: data.categories, completedIds: data.completedIds,
      activeCourse: data.activeCourse, now: state.now,
    });
    const labelBox = function (b) {
      return {
        key: b.key, name: b.name, bachelorPrefix: b.bachelorPrefix,
        courseCount: b.courseCount, totalSeconds: b.totalSeconds, finishesAt: b.finishesAt,
        durationLabel: formatDuration(b.totalSeconds),
        finishLabel: `${formatDate(b.finishesAt)} · ${formatTime(b.finishesAt)} TCT`,
      };
    };
    const grid = {
      sumsDiffer: rawGrid.sumsDiffer,
      boxes: rawGrid.boxes.map(labelBox),
      allBox: labelBox(rawGrid.allBox),
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
          jobPoints: settings.jobPoints,
        })
      : null;
    // startsAt + seconds, not finishesAt - saving: the queue begins when the
    // active course ends, and that anchor is the only fixed point either date
    // can be measured from.
    const consumablesModel = consumables ? {
      // The job-point line is the path the Books then work on, so it renders
      // above them — the view's line order is the calculation's order.
      jobPoints: consumables.jobPoints,
      jobPointFinishLabel: `${formatDate(result.startsAt + consumables.jobPointSeconds)} · ${formatTime(result.startsAt + consumables.jobPointSeconds)} TCT`,
      jobPointDurationLabel: formatDuration(consumables.jobPointSeconds),
      ceiling: consumables.ceiling,
      plannedBooks: consumables.plannedBooks,
      plannedFinishLabel: `${formatDate(result.startsAt + consumables.plannedSeconds)} · ${formatTime(result.startsAt + consumables.plannedSeconds)} TCT`,
      plannedDurationLabel: formatDuration(consumables.plannedSeconds),
      floorBooks: consumables.floorBooks,
      floorFinishLabel: `${formatDate(result.startsAt + consumables.floorSeconds)} · ${formatTime(result.startsAt + consumables.floorSeconds)} TCT`,
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

    const moveCache = new Map();
    const queueItems = queue.map(function (id) {
      const course = data.courses.get(id);
      const up = canMoveQueueCourse(queue, id, 'up', data.courses, moveCache);
      const down = canMoveQueueCourse(queue, id, 'down', data.courses, moveCache);
      const disabledTitle = function (move, direction) {
        if (move.reason === 'boundary') return direction === 'up'
          ? 'Already first in the queue.'
          : 'Already last in the queue.';
        if (move.reason === 'prerequisite') {
          const blocking = data.courses.get(move.blockingCourseId);
          const blockingPrefix = blocking ? blocking.prefix : 'that course';
          return direction === 'up'
            ? `Cannot move before ${blockingPrefix}; it is a prerequisite.`
            : `Cannot move after ${blockingPrefix}; this course is its prerequisite.`;
        }
        return 'This course cannot be moved in that direction.';
      };
      return {
        courseId: id,
        prefix: course.prefix,
        name: course.name,
        duration: course.duration,
        durationLabel: formatDuration(course.duration),
        finishesAt: finishById.get(id),
        finishLabel: `${formatDate(finishById.get(id))} · ${formatTime(finishById.get(id))} TCT`,
        bonusLabel: bonusLabel(course),
        canMoveUp: up.allowed,
        canMoveDown: down.allowed,
        moveUpTitle: up.allowed ? `Move ${course.prefix} up` : disabledTitle(up, 'up'),
        moveDownTitle: down.allowed ? `Move ${course.prefix} down` : disabledTitle(down, 'down'),
      };
    });

    // The finish date's own gate, so the button's disabled state and the
    // finish line cannot disagree about whether this queue is a plan. The
    // summary itself is built only while open: pathGains costs about 7 ms on
    // a full queue, and every click redraws.
    const summaryAvailable = queue.length > 0 && problems.length === 0;
    const summaryOpen = state.summaryOpen === true && summaryAvailable;
    const pathSummary = summaryOpen
      ? pathSummaryModel(pathGains(queue, data.courses), {
          totalLabel: formatDuration(result.totalSeconds),
          finishLabel: `${formatDate(result.finishesAt)} · ${formatTime(result.finishesAt)} TCT`,
        })
      : null;

    return {
      status: 'ok',
      message: null,
      reductionLabel: reductionLabel(data.reduction),
      addable: addable,
      guidePresets: guidePresets,
      stale: stale,
      queue: queueItems,
      problems: problems,
      // A wrong date stated confidently is worse than no date at all. When the
      // queue has unmet prerequisites it is not a plan the player can actually
      // follow in order, so schedule()'s sum describes a fiction — withhold it
      // rather than print it. The problems list itself (rendered above) already
      // names what is missing.
      finishLabel: (queue.length > 0 && problems.length === 0)
        ? `${formatDate(result.finishesAt)} · ${formatTime(result.finishesAt)} TCT`
        : null,
      totalLabel: (queue.length > 0 && problems.length === 0) ? formatDuration(result.totalSeconds) : null,
      collapsed: state.plan.collapsed === true,
      saveError: state.saveFailed === true,
      presetError: state.presetError || null,
      queueNotice: state.queueNotice || null,
      selectedCourseId: state.selectedCourseId != null ? state.selectedCourseId : null,
      view: state.view || 'schedule',
      // See the same field on the failure model above: it is read here, not
      // stored — a redraw for any other reason is what disarms it.
      resetArmed: state.resetArmed === true,
      settings: settings,
      settingsSaveError: state.settingsSaveFailed === true,
      perkInference: perkInference,
      consumables: consumablesModel,
      // Closure state in init(), never stored. A summary cannot be open with
      // nothing to show, even if a queue edit removed it between draws.
      summaryAvailable: summaryAvailable,
      summaryReason: summaryAvailable ? null
        : (queue.length === 0 ? PATH_SUMMARY_REASONS.empty : PATH_SUMMARY_REASONS.prerequisites),
      summaryOpen: summaryOpen,
      pathSummary: pathSummary,
      orderModes: ORDER_MODE_LABELS,
      debugReport: state.debugReport || null,
      grid: grid,
      focusGroups: focusGroups,
      focuses: settings.focuses,
      focusHealth: focusHealth,
      focusOpenCategories: Array.isArray(state.focusOpenCategories) ? state.focusOpenCategories : [],
      focusOpenCompletedCategories: Array.isArray(state.focusOpenCompletedCategories)
        ? state.focusOpenCompletedCategories
        : [],
      // Built from the pruned queue, in storage order — never the ordered
      // queue: ordering is a display preference, and storage keeps the raw
      // order. Sharing the ordered queue would silently rewrite a hand-built
      // order to whatever the current orderMode produces on the next import,
      // with no bulk undo.
      shareText: encodePlan({ queue: prunedQueue }, settings),
      importError: state.importError || null,
    };
  }

  // Every field in the report is named explicitly here, so nothing reaches it
  // by riding along on some object that got passed in.
  //
  // GM_info is read through a typeof guard rather than added to @grant: it is
  // ambient in every manager, and a grant would widen the security surface for
  // a diagnostic nicety. navigator and course.prefix are guarded the same way.
  // Non-strings are dropped rather than coerced, so nothing reaches String()
  // carrying a toString we did not write.
  //
  // The length bound is on the detail because Torn's own error text is spliced
  // into it whole, and that string is not ours to size. The report is pasted in
  // public by hand. Truncation is marked, so nothing disappears silently.
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
    // Counts only — never a selection's course list, never an outcome
    // string. focusRegistry needs real course data to say anything, so both
    // are null on a failed acquisition.
    const focusReg = data ? focusRegistry(data.courses) : null;
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
      focusStale: focusReg ? focusReg.stale : null,
      focusUnmapped: focusReg ? focusReg.unmapped : null,
      // settings.focuses' own length, not a stored count — present whenever
      // settings are, independent of whether acquisition succeeded.
      focusSelections: (state.settings && Array.isArray(state.settings.focuses))
        ? state.settings.focuses.length
        : null,
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
      // A React replacement can leave the old host reachable briefly. Mounting
      // into a node explicitly known to be detached produces a panel that no
      // player can see; DOM stubs and older webviews may omit isConnected, so
      // only the definite false case is rejected.
      if (el && el.isConnected !== false) return el;
    }
    return null;
  }

  function resolvePanelMount(doc) {
    let mount = null;
    let mountError = null;
    try {
      mount = findMountPoint(doc);
    } catch (e) {
      mountError = (e && e.message) || String(e);
    }
    if (!mount) mount = queryOne(doc, '#tes-fallback-mount');
    if (!mount) {
      try {
        mount = doc.createElement('div');
        mount.id = 'tes-fallback-mount';
        doc.body.appendChild(mount);
      } catch (e) {
        return { mount: null, error: mountError || ((e && e.message) || String(e)) };
      }
    }
    return { mount: mount, error: mountError };
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

  // The exact string injected into the page's <style id="tes-style"> tag.
  // Pulled out of injectStyleOnce so a test can assert on a rule (e.g. the
  // bachelor colour below) without a DOM to read the <style> element back
  // out of. A later design-tokens pass also depends on this returning the
  // literal emitted text, not a summary of it.
  function panelStyleText() {
    return [
      // Colour values are Bookie's default scheme, panel-root block
      // (Torn_Bookie_Live_Scores.js:8244). NOT .tm-theme-default, which is a
      // nested component's local palette and disagrees with this one — see the
      // spec's table. Type, spacing and focus are local, hence --tes-*: the
      // --tm-* prefix means "matches Bookie", and these do not.
      //
      // No --tm-font. The panel inherits Torn's font, which is what makes it
      // look like part of the page rather than bolted on.
      '#tes-panel {',
      '  --tm-bg: #1f1f1f; --tm-bg-3: #111111; --tm-hover: #292929;',
      '  --tm-border-2: #555555; --tm-text: #ffffff; --tm-muted: #b8b8b8; --tm-meta: #cfcfcf;',
      // Bookie's green fill now distinguishes Settings header bars; it is never
      // used as text. The measured -text variants remain the only green/red
      // text colours because they clear AA against the panel background.
      '  --tm-good-bg: #2a6b3a; --tm-good-text: #7ee081; --tm-bad-text: #ff8080; --tm-accent-text: #6ea3d0;',
      '  --tes-text-sm: 12px; --tes-text: 14px; --tes-text-lg: 1.25em;',
      '  --tes-gap-xs: 4px; --tes-gap-sm: 6px; --tes-gap: 8px; --tes-gap-lg: 14px;',
      '  --tes-focus-ring: 2px solid var(--tm-good-text);',
      '}',
      '#tes-fallback-mount { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;',
      '  box-sizing: border-box; width: min(720px, calc(100vw - 24px)); max-width: calc(100vw - 24px);',
      '  max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); overflow-y: auto; }',
      '#tes-fallback-mount #tes-panel { min-width: 0; margin: 0; }',
      '#tes-panel { border: 1px solid var(--tm-border-2); background: var(--tm-bg); color: var(--tm-text);',
      // No 4px/8px step sums to 12px, so the outer margin is the one place a
      // token is a sum rather than a single step — this keeps the panel's
      // distance from the rest of the page pixel-identical to before, rather
      // than snapping to the nearest single gap and shifting it either way.
      '  padding: 12px 14px; margin: calc(var(--tes-gap) + var(--tes-gap-xs)) 0; border-radius: 6px;',
      '  font-size: var(--tes-text); line-height: 1.5; }',
      '#tes-panel .tes-header { font-weight: bold; margin-bottom: var(--tes-gap);',
      '  display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
      '#tes-panel .tes-header-toggle { font-weight: normal; }',
      '#tes-panel .tes-nav { display: flex; gap: 6px; margin-bottom: var(--tes-gap); }',
      '#tes-panel .tes-nav .tes-settings { margin-left: auto; }',
      '#tes-panel .tes-reset-armed { border-color: var(--tm-bad-text); color: var(--tm-bad-text); }',
      '#tes-panel .tes-finish { font-size: var(--tes-text-lg); font-weight: bold; color: var(--tm-good-text); margin-bottom: var(--tes-gap); }',
      '#tes-panel .tes-save-error { color: var(--tm-bad-text); font-weight: bold; margin-bottom: var(--tes-gap); }',
      '#tes-panel .tes-error { color: var(--tm-bad-text); margin-bottom: var(--tes-gap); }',
      '#tes-panel .tes-summary { margin-bottom: var(--tes-gap); }',
      '#tes-panel .tes-overview { border: 1px solid var(--tm-good-text); border-radius: 4px;',
      '  background: var(--tm-bg-3); padding: var(--tes-gap); margin-bottom: var(--tes-gap-lg); }',
      '#tes-panel .tes-overview > :last-child { margin-bottom: 0; }',
      // The overview outline now separates assumptions from course rows, so
      // the old divider below Total queued time would be a doubled boundary.
      '#tes-panel .tes-summary-result { margin-top: var(--tes-gap-sm); }',
      '#tes-panel .tes-summary-diagnostics { white-space: pre-line; margin-top: var(--tes-gap-sm); }',
      '#tes-panel .tes-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0; }',
      // Queue entries and booster scenarios are quiet divided rows, never card
      // surfaces: no background or hover treatment to imply interaction.
      '#tes-panel .tes-queue-row { position: relative; display: grid; grid-template-columns: 30px minmax(0, 1fr) auto;',
      '  align-items: center; gap: 2px 8px; padding: var(--tes-gap-sm) 0;',
      '  border-bottom: 1px solid var(--tm-border-2); }',
      // Absolute positioning lets the control consume the row's existing
      // vertical padding. It therefore receives the full current row height
      // without becoming content that can make that row taller.
      '#tes-panel .tes-reorder { position: absolute; inset-block: 0; inset-inline-start: 0;',
      '  display: flex; flex-direction: column; width: 30px; }',
      '#tes-panel .tes-queue-main { grid-column: 2; min-width: 0; overflow-wrap: anywhere; font-weight: bold; }',
      '#tes-panel .tes-queue-detail { grid-column: 2; min-width: 0; overflow-wrap: anywhere;',
      '  color: var(--tm-meta); font-size: var(--tes-text-sm); }',
      '#tes-panel .tes-remove-course { grid-column: 3; grid-row: 1 / span 2; }',
      '#tes-panel .tes-boosters { margin-bottom: var(--tes-gap); }',
      '#tes-panel .tes-booster-row { display: grid; grid-template-columns: minmax(0, 1fr) auto;',
      '  gap: 2px var(--tes-gap); padding: var(--tes-gap-sm) 0;',
      '  border-bottom: 1px solid var(--tm-border-2); }',
      '#tes-panel .tes-booster-name { min-width: 0; overflow-wrap: anywhere; font-weight: bold; }',
      '#tes-panel .tes-booster-finish { text-align: right; white-space: nowrap;',
      '  font-variant-numeric: tabular-nums; }',
      '#tes-panel .tes-booster-detail { grid-column: 1 / -1; color: var(--tm-meta);',
      '  font-size: var(--tes-text-sm); font-variant-numeric: tabular-nums; }',
      // padding, not font-size, carries the button to a 44px touch target —
      // density (font-size, line-height) is unchanged by this pass.
      '#tes-panel button, #tes-panel select { color: var(--tm-text); background: var(--tm-hover); border: 1px solid var(--tm-border-2);',
      '  border-radius: 4px; padding: 8px 12px; cursor: pointer; font-size: inherit; }',
      '#tes-panel button:hover { border-color: var(--tm-good-text); }',
      // The focus ring belongs to this pass, not a later one: --tes-focus-ring
      // is declared above, and a design-token block that declares a token no
      // rule consumes is exactly the dead weight this refactor exists to
      // remove. focus-visible, not focus, so a mouse click leaves no ring
      // behind — before this rule, tabbing through the settings form gave no
      // indication of position at all.
      '#tes-panel button:focus-visible, #tes-panel select:focus-visible,',
      '#tes-panel input:focus-visible, #tes-panel textarea:focus-visible {',
      '  outline: var(--tes-focus-ring); outline-offset: 2px; }',
      // Option B: two neutral ghost buttons touching at the middle. The icon
      // is small, but each semantic button owns half of every pixel the row
      // already provides. These rules deliberately override the shared green
      // hover/focus treatment without introducing black into the control.
      '#tes-panel .tes-move { flex: 1 1 50%; min-height: 0; padding: 0;',
      '  display: flex; align-items: center; justify-content: center;',
      '  box-sizing: border-box; color: var(--tm-meta); background: transparent;',
      '  border-color: transparent; border-radius: 0; line-height: 1; }',
      '#tes-panel .tes-move:hover:not(:disabled) { color: var(--tm-text); background: var(--tm-hover); border-color: transparent; }',
      '#tes-panel .tes-move:focus-visible { outline: 2px solid var(--tm-meta); outline-offset: -2px; z-index: 1; }',
      '#tes-panel .tes-move:disabled { color: var(--tm-border-2); background: transparent;',
      '  border-color: transparent; cursor: default; }',
      '#tes-panel .tes-chevron { width: 7px; height: 7px; border-style: solid; border-width: 2px 0 0 2px; }',
      '#tes-panel .tes-chevron-up { transform: rotate(45deg); }',
      '#tes-panel .tes-chevron-down { transform: rotate(225deg); }',
      '#tes-panel .tes-section { margin-bottom: var(--tes-gap-lg); }',
      '#tes-panel .tes-section-header { display: flex; align-items: baseline; justify-content: space-between;',
      '  flex-wrap: wrap; gap: var(--tes-gap-xs) var(--tes-gap); padding: var(--tes-gap-sm) var(--tes-gap);',
      '  margin-bottom: var(--tes-gap); border-radius: 4px; background: var(--tm-good-bg); }',
      '#tes-panel .tes-section-title { font-weight: bold; color: var(--tm-text); }',
      '#tes-panel .tes-section-role { color: var(--tm-text); font-size: var(--tes-text-sm); }',
      '#tes-panel .tes-focus-section { border: 1px solid var(--tm-border-2); border-radius: 4px; padding: 8px; margin-bottom: var(--tes-gap-lg); }',
      '#tes-panel .tes-focus-section-header { display: grid; grid-template-columns: 2.5em 1fr auto; align-items: center; gap: 8px; }',
      '#tes-panel .tes-focus-section-title { width: 100%; text-align: left; }',
      '#tes-panel .tes-focus-section-count { justify-self: end; color: var(--tm-muted); font-size: var(--tes-text-sm); white-space: nowrap; }',
      '#tes-panel .tes-focus-priority-slot { width: 2.5em; }',
      '#tes-panel .tes-focus-row { display: grid; grid-template-columns: 1.5em 1fr auto; align-items: center; gap: 8px; padding: 2px 0; }',
      '#tes-panel .tes-focus-row input[type="checkbox"] { width: auto; }',
      '#tes-panel .tes-focus-row[data-disabled="true"] { color: var(--tm-muted); }',
      '#tes-panel .tes-focus-completed { border-top: 1px solid var(--tm-border-2); margin-top: var(--tes-gap-sm); padding-top: 6px; }',
      '#tes-panel .tes-focus-completed-title { width: 100%; text-align: left; color: var(--tm-muted);',
      '  background: var(--tm-bg-3); font-size: var(--tes-text-sm); }',
      '#tes-panel .tes-focus-remaining { justify-self: end; text-align: right; }',
      '#tes-panel .tes-focus-priority { box-sizing: border-box; width: 2.5em; }',
      '#tes-panel .tes-focus-rank-toggle { margin-bottom: var(--tes-gap); }',
      '#tes-panel .tes-note { color: var(--tm-muted); margin-bottom: var(--tes-gap-sm); font-size: var(--tes-text-sm); }',
      '#tes-panel input { color: var(--tm-text); background: var(--tm-hover); border: 1px solid var(--tm-border-2);',
      '  border-radius: 4px; padding: 3px 6px; font-size: inherit; width: 10em; }',
      '#tes-panel input[type="number"] { font-variant-numeric: tabular-nums; }',
      // The report is shown before it can be copied, so it needs to be
      // readable in place: wrapped, scrollable, and visibly a block of text
      // the player is about to hand to someone else.
      '#tes-panel .tes-report { white-space: pre-wrap; word-break: break-word; background: var(--tm-bg-3);',
      '  border: 1px solid var(--tm-border-2); border-radius: 4px; padding: 8px; margin: var(--tes-gap) 0; max-height: 240px; overflow: auto; }',
      // auto-fit rather than a viewport query: the width that matters belongs
      // to Torn's column, so tracks collapse naturally from two to one.
      '#tes-panel .tes-degree-list { display: grid;',
      '  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));',
      '  column-gap: var(--tes-gap-lg); margin: var(--tes-gap) 0; }',
      '#tes-panel .tes-degree-row { display: grid; grid-template-columns: minmax(0, 1fr) auto;',
      '  align-items: center; gap: var(--tes-gap); padding: var(--tes-gap-sm) 0;',
      '  border-bottom: 1px solid var(--tm-border-2); }',
      '#tes-panel .tes-degree-main { min-width: 0; overflow-wrap: anywhere; }',
      '#tes-panel .tes-degree-identity { font-weight: bold; }',
      '#tes-panel .tes-degree-detail { color: var(--tm-meta); font-size: var(--tes-text-sm); }',
      '#tes-panel .tes-degree-date { text-align: right; white-space: nowrap;',
      '  font-variant-numeric: tabular-nums; }',
      '#tes-panel .tes-degree-complete .tes-degree-identity,',
      '#tes-panel .tes-degree-complete .tes-degree-date { color: var(--tm-muted); }',
      '#tes-panel .tes-all-banner { display: grid; grid-template-columns: minmax(0, 1fr) auto;',
      '  align-items: center; gap: var(--tes-gap); border: 1px solid var(--tm-good-text);',
      '  border-radius: 4px; background: var(--tm-bg-3); padding: var(--tes-gap); margin: var(--tes-gap) 0; }',
      '#tes-panel .tes-all-title { min-width: 0; overflow-wrap: anywhere; font-size: var(--tes-text-lg);',
      '  font-weight: bold; color: var(--tm-text); }',
      '#tes-panel .tes-all-figures { display: flex; align-items: baseline; justify-content: flex-end;',
      '  flex-wrap: wrap; gap: var(--tes-gap-xs) var(--tes-gap); text-align: right; }',
      '#tes-panel .tes-all-finish { color: var(--tm-good-text); font-size: var(--tes-text-lg);',
      '  font-weight: bold; white-space: nowrap; font-variant-numeric: tabular-nums; }',
      '#tes-panel .tes-all-meta { color: var(--tm-meta); font-size: var(--tes-text-sm);',
      '  font-variant-numeric: tabular-nums; }',
      '#tes-panel .tes-share { width: 100%; box-sizing: border-box; color: var(--tm-text); background: var(--tm-hover);',
      '  border: 1px solid var(--tm-border-2); border-radius: 4px; padding: 6px; font-family: monospace; font-size: 0.95em; }',
      '#tes-panel .tes-foot { margin-top: var(--tes-gap); color: var(--tm-muted); font-size: var(--tes-text-sm); }',
      '#tes-panel a { color: var(--tm-good-text); }',
      // Best-effort by nature: Chrome and Firefox on Windows and Linux honour a
      // colour on an <option>; macOS draws the menu itself and commonly ignores
      // it, so those players see no marker. Accepted trade — no fallback prefix,
      // since one would reinstate for some users what removing it was for.
      '#tes-panel .tes-option-bachelor { color: var(--tm-good-text); }',
      '#tes-panel .tes-option-preset { color: var(--tm-accent-text); }',
      '@media (max-width: 480px) {',
      '  #tes-fallback-mount { right: 6px; bottom: 6px; width: calc(100vw - 12px); max-width: calc(100vw - 12px);',
      '    max-height: calc(100vh - 12px); max-height: calc(100dvh - 12px); }',
      '  #tes-panel { box-sizing: border-box; width: 100%; max-width: 100%; }',
      '  #tes-panel .tes-nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }',
      '  #tes-panel .tes-nav .tes-settings { margin-left: 0; }',
      '  #tes-panel .tes-nav button { min-width: 0; width: 100%; white-space: normal; }',
      '  #tes-panel .tes-course-picker { box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0; }',
      '  #tes-panel .tes-all-banner { grid-template-columns: minmax(0, 1fr); align-items: start; }',
      '  #tes-panel .tes-all-title { overflow-wrap: normal; }',
      '  #tes-panel .tes-all-figures { min-width: 0; justify-content: flex-start; text-align: left; }',
      '  #tes-panel .tes-all-finish { white-space: normal; overflow-wrap: anywhere; }',
      '}',
    ].join('\n');
  }

  function injectStyleOnce(doc) {
    if (queryOne(doc, '#tes-style')) return;
    const style = doc.createElement('style');
    style.id = 'tes-style';
    style.textContent = panelStyleText();
    // Reading head/body is a property access on a document we do not own; a
    // page that throws here must still get its panel.
    let parent = null;
    try { parent = doc.head || doc.body; } catch (e) { parent = null; }
    if (parent && parent.appendChild) parent.appendChild(style);
  }

  // The header names the view you are looking at, so a collapsed-then-reopened
  // panel is not ambiguous about what it is showing.
  const VIEW_TITLES = { schedule: 'Education Scheduler', settings: 'Settings', grid: 'Degrees', focus: 'Focus' };

  // One nav button: label and click wiring, shared by every button the nav
  // row renders. Callers set `className`/`aria-current` themselves — this
  // only owns what every button has in common.
  function navButton(doc, target, label, handlers) {
    const btn = doc.createElement('button');
    btn.textContent = label;
    if (btn.addEventListener && handlers.onViewChange) {
      btn.addEventListener('click', function () {
        handlers.onViewChange(target);
      });
    }
    return btn;
  }

  // The shell only: chrome, the failure line, the nav row, and the view switch.
  // Each view owns its own body content, so adding a view never grows this
  // function. It is always handed a complete model, and a failure is always
  // visible.
  function renderPanel(doc, mount, model, handlers) {
    injectStyleOnce(doc);

    const existing = queryOne(doc, '#tes-panel');
    if (existing && existing.remove) existing.remove();

    const panel = doc.createElement('div');
    panel.id = 'tes-panel';
    panel.setAttribute('data-tes-version', SCRIPT_VERSION);

    const view = model.view || 'schedule';

    // Two elements, not one clickable div. The title names the view; the button
    // is a real button that looks like every other button in the panel, and it
    // is the only thing that toggles. `justify-content: space-between` on
    // `.tes-header` puts it right, not a margin on the button itself.
    const header = doc.createElement('div');
    header.className = 'tes-header';

    const title = doc.createElement('span');
    title.className = 'tes-header-title';
    title.textContent = VIEW_TITLES[view] || VIEW_TITLES.schedule;
    header.appendChild(title);

    if (handlers !== noopHandlers) {
      const toggle = doc.createElement('button');
      toggle.className = 'tes-header-toggle';
      toggle.textContent = model.collapsed ? 'show' : 'hide';
      if (toggle.addEventListener) toggle.addEventListener('click', handlers.onToggle);
      header.appendChild(toggle);
    }

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
      } else if (model.status === 'loading') {
        const loading = doc.createElement('div');
        loading.className = 'tes-loading';
        loading.textContent = model.message;
        body.appendChild(loading);
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

        // Planner destinations are fixed controls, including the current
        // view. Focus is normally present because it is the default Queue
        // order; an empty focus list still orders as listed, so a new player
        // sees the same queue. It disappears only after a player deliberately
        // selects another ordering, when they already know the feature exists.
        for (const target of ['schedule', 'grid', 'focus']) {
          if (target === 'focus' && model.settings.orderMode !== 'focus') continue;
          const label = target === 'grid' ? 'degrees' : target === 'focus' ? 'focus' : 'schedule';
          const btn = navButton(doc, target, label, handlers);
          if (target === view) btn.setAttribute('aria-current', 'page');
          nav.appendChild(btn);
        }

        // Settings is a fixed landmark, not a fourth toggle target: it
        // renders on every view, identically, always enabled — a landmark
        // that greys out or moves when you land on it is not a landmark.
        // `.tes-settings { margin-left: auto }` (CSS) pins it to the right
        // of the row regardless of how many buttons sit to its left, so it
        // does not shift as the planner group grows from one button to two.
        // A reset button appends here too, AFTER this one, and inherits the
        // same right-hand group without needing its own margin-left: auto —
        // a second auto margin on the same flex row would do nothing useful.
        const gear = navButton(doc, 'settings', '⚙ settings', handlers);
        gear.className = 'tes-settings';
        // Idempotent when already on settings — cheaper than a disabled
        // state that would make the button look different on one view out
        // of four.
        if (view === 'settings') gear.setAttribute('aria-current', 'page');
        nav.appendChild(gear);

        // Right-aligned by margin-left:auto, so it must stay last in this
        // row. Degrees owns no player data and gets nothing; the enclosing
        // `handlers !== noopHandlers` guard above already covers the panel
        // that cannot respond, and a collapsed panel renders no nav row at
        // all.
        if (view === 'schedule' || view === 'focus' || view === 'settings') {
          resetButton(doc, nav, view === 'settings' ? 'defaults' : 'reset',
            model.resetArmed === true, handlers.onResetArm, handlers.onResetConfirm);
        }

        body.appendChild(nav);
      }

      // Settings renders in full either way — it reads nothing from the
      // payload. Schedule, Degrees and Focus have nothing to draw without
      // data, and the failure line above is the whole of what they have to
      // say, so they are skipped rather than rendered empty.
      if (view === 'settings') renderSettingsView(doc, body, model, handlers);
      else if (model.status === 'error') { /* the failure line is the view */ }
      else if (model.status === 'loading') { /* the loading line is the view */ }
      else if (view === 'grid') renderGridView(doc, body, model, handlers);
      else if (view === 'focus') renderFocusView(doc, body, model, handlers);
      else renderScheduleView(doc, body, model, handlers);

      panel.appendChild(body);
    }

    mount.appendChild(panel);
    return panel;
  }

  // Which settings paths carry a number, so onSettingChange knows what to
  // coerce. orderMode and focusRankBasis are string enums: running either
  // through Number() would make every choice NaN, and normaliseSettings would
  // quietly restore the default — a preference that silently refuses to change.
  const NUMERIC_SETTING_FIELDS = [
    'maxCooldownHours', 'booksOwned', 'bookPrice', 'jobPoints', 'perks.meritsPercent',
  ];

  // A labelled section per group, not a flat list: later releases add fields
  // and the shell has to absorb them without restructuring. The short role is
  // layout copy: it says whether the section affects dates/order or is a tool,
  // without forcing the heading itself to carry a warning sentence.
  function settingsSection(doc, body, title, role) {
    const section = doc.createElement('div');
    section.className = 'tes-section';
    const header = doc.createElement('div');
    header.className = 'tes-section-header';
    const heading = doc.createElement('div');
    heading.className = 'tes-section-title';
    heading.textContent = title;
    header.appendChild(heading);
    const roleLabel = doc.createElement('div');
    roleLabel.className = 'tes-section-role';
    roleLabel.textContent = role;
    header.appendChild(roleLabel);
    section.appendChild(header);
    body.appendChild(section);
    return section;
  }

  // Focus categories are collapsed independently and are deliberately not
  // settings sections: their heading is a control, while settings headings
  // must remain inert labels with the exact shape their callers expect.
  function focusSection(doc, body, title, selections, chosen, expanded, onToggle, onPriority) {
    const section = doc.createElement('div');
    section.className = 'tes-focus-section';
    const header = doc.createElement('div');
    header.className = 'tes-focus-section-header';
    const prioritySlot = doc.createElement('span');
    prioritySlot.className = 'tes-focus-priority-slot';
    // This header renders even while its section is collapsed, so the whole
    // focus list stays visible and editable without opening any section.
    if (chosen) {
      const priorityInput = doc.createElement('input');
      priorityInput.className = 'tes-focus-priority';
      priorityInput.setAttribute('type', 'number');
      priorityInput.setAttribute('min', '1');
      priorityInput.value = String(chosen.priority);
      if (priorityInput.addEventListener) {
        priorityInput.addEventListener('change', function () {
          onPriority(chosen.selection, Number(priorityInput.value));
        });
      }
      prioritySlot.appendChild(priorityInput);
    }
    header.appendChild(prioritySlot);
    const heading = doc.createElement('button');
    heading.className = 'tes-focus-section-title';
    heading.textContent = chosen ? `${title} — ${chosen.selection}` : title;
    heading.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (heading.addEventListener) heading.addEventListener('click', onToggle);
    header.appendChild(heading);
    const total = selections.length;
    const complete = selections.filter(function (selection) { return selection.remainingLabel === 'complete'; }).length;
    const count = doc.createElement('span');
    count.className = 'tes-focus-section-count';
    count.textContent = `${total - complete} rem /${total} total`;
    header.appendChild(count);
    section.appendChild(header);
    body.appendChild(section);
    return section;
  }

  // Two clicks, because a queue is a plan built by hand and there is no undo
  // anywhere in this panel. It shares a row with four buttons that only change
  // what you are looking at, which makes a misclick MORE likely than it would
  // be alone, not less — hence the arm, and hence the colour change so the two
  // states cannot be confused at a glance.
  //
  // The armed state is the caller's, not this function's: it belongs to
  // init()'s closure so that a redraw for any other reason disarms it, and so
  // it can never be written to storage.
  //
  // The label changes rather than a dialog appearing — a confirm() would be a
  // modal on someone else's page, and this panel does not own the tab.
  function resetButton(doc, nav, label, armed, onArm, onConfirm) {
    const btn = doc.createElement('button');
    btn.className = armed ? 'tes-reset tes-reset-armed' : 'tes-reset';
    btn.textContent = armed ? `${label} — sure?` : label;
    if (btn.addEventListener) {
      btn.addEventListener('click', function () {
        if (armed) onConfirm(); else onArm();
      });
    }
    nav.appendChild(btn);
    return btn;
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

    const boosters = settingsSection(doc, body, 'Boosters', 'Affects dates');
    // First in the section because it is first in the arithmetic
    // (planConsumables): points come off the path, and the Book figures are
    // computed against what they leave behind. Reading the section top to
    // bottom is reading the calculation in order.
    numberField(doc, boosters, 'Job points available', s.jobPoints, function (v) { set('jobPoints', v); });
    const jobPointNote = doc.createElement('div');
    jobPointNote.className = 'tes-note';
    jobPointNote.textContent = 'Each job point removes 30 minutes from a queued course, and points are spent before any Book of Carols — so the Book figures on the schedule are what is left after them. Time already running on your current course is not affected.';
    boosters.appendChild(jobPointNote);
    numberField(doc, boosters, 'Max booster cooldown (hours)', s.maxCooldownHours, function (v) { set('maxCooldownHours', v); });
    numberField(doc, boosters, 'Books of Carols owned', s.booksOwned, function (v) { set('booksOwned', v); });
    numberField(doc, boosters, 'Book of Carols price', s.bookPrice, function (v) { set('bookPrice', v); });

    // What the defaults button (below, in the nav row) is about to do to this
    // whole form — stated once, beside the section a player opening Settings
    // sees first, rather than only beside the button itself.
    const resetNote = doc.createElement('div');
    resetNote.className = 'tes-note';
    resetNote.textContent = 'Resetting to defaults clears what you typed. The perk fields will refill with what the panel inferred from your reduction — typing over them is what makes a value yours.';
    boosters.appendChild(resetNote);

    const planning = settingsSection(doc, body, 'Planning', 'Affects order');
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
    orderNote.textContent = "Order does not change the finish date — courses run one at a time, so the total is the same either way. It changes how soon each course's bonus starts paying off. It can also turn a queue with no date into one with a date: a queue whose courses are all valid but listed out of sequence can fail as-listed and succeed under the other two modes, which reorder to something followable.";
    planning.appendChild(orderNote);

    const recorded = settingsSection(
      doc, body, 'Education perks', 'Saved only · not used in dates'
    );
    const recordedNote = doc.createElement('div');
    recordedNote.className = 'tes-note';
    recordedNote.textContent = 'These fields do not change any date the panel shows: Torn has already applied your education perks to the course durations it sends, so the panel reads those durations rather than rebuilding them from these values. They are kept so they travel with a shared plan and a debug report. Job points are not among them — they are spent by you, on courses you have not started yet, so they live in Boosters and do move the dates.';
    recorded.appendChild(recordedNote);
    // The note carries the honesty: it names the inference as an inference, so
    // a prefilled field is never mistaken for something we read off the account.
    const note = doc.createElement('div');
    note.className = 'tes-note';
    note.textContent = model.perkInference.note;
    recorded.appendChild(note);
    numberField(doc, recorded, 'Merits reduction (%)', s.perks.meritsPercent === null ? '' : s.perks.meritsPercent, function (v) { set('perks.meritsPercent', v); });
    triStateField(doc, recorded, 'Principal rank (10%)', s.perks.principal, function (v) { set('perks.principal', v); });
    triStateField(doc, recorded, 'WSU stock block (10%)', s.perks.wsuBlock, function (v) { set('perks.wsuBlock', v); });

    const help = settingsSection(doc, body, 'Help', 'Troubleshooting');

    // One compact line, and nothing at all while the URL is unresolved — not a
    // dead link, not a "#" href, not placeholder text pretending to be a link.
    if (isResolvedUrl(FORUM_POST_URL)) {
      const guide = doc.createElement('div');
      const link = doc.createElement('a');
      link.setAttribute('href', FORUM_POST_URL);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.textContent = "A beginner's guide to education — which courses to take first, and why";
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
    const share = settingsSection(doc, body, 'Share this plan', 'Export or import');
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

    const rankBasis = FOCUS_RANK_BASIS_LABELS.find(function (basis) {
      return basis.id === model.settings.focusRankBasis;
    }) || FOCUS_RANK_BASIS_LABELS[0];
    const overview = doc.createElement('div');
    overview.className = 'tes-overview tes-focus-overview';
    const rankToggle = handlers.onFocusRankToggle || function () {};
    const rankButton = doc.createElement('button');
    rankButton.className = 'tes-focus-rank-toggle';
    rankButton.textContent = `sorting: ${rankBasis.label}`;
    if (rankButton.addEventListener) rankButton.addEventListener('click', rankToggle);
    overview.appendChild(rankButton);

    // The one thing this view must not be left to imply — see the settings
    // view's identical worry about Queue order in general. Focus reorders;
    // it does not shorten or lengthen anything, because courses still run
    // one at a time and the sum is order-independent.
    const orderNote = doc.createElement('div');
    orderNote.className = 'tes-note';
    orderNote.textContent = 'Choosing a focus changes the order courses are queued in — it does not change the finish date. The total time is the same either way; a focus just moves the courses that earn it earlier, so that benefit starts paying off sooner. Most per day banks the stat fastest in real time; biggest total finishes the largest single courses first, and the button above switches between them.';
    if (Array.isArray(model.focuses) && model.focuses.length === 0) {
      orderNote.textContent += ' With nothing selected, the queue uses a balanced default: gain multipliers first, then courses with the largest measurable benefit per day, then unlocks. It is a starting point, not a claim about what is optimal for you.';
    }
    overview.appendChild(orderNote);

    // Torn does not attach a learningOutcomes entry to every course. Silence
    // on 31 of them would read as "these have nothing," which is wrong for
    // the ones whose only benefit is a working-stat gain — the one category
    // this view computes rather than classifies.
    const outcomeNote = doc.createElement('div');
    outcomeNote.className = 'tes-note';
    outcomeNote.textContent = '31 courses grant no learning outcome at all. Working Stats is the only focus category that can still reach them.';
    overview.appendChild(outcomeNote);

    // A stale or unmapped count names a live disagreement between the
    // taxonomy and today's payload — shown, never swallowed, because a silent
    // zero here would rank a real benefit as worthless or trust a judgement
    // that no longer applies.
    if (model.focusHealth && (model.focusHealth.stale > 0 || model.focusHealth.unmapped > 0)) {
      const healthNote = doc.createElement('div');
      healthNote.className = 'tes-note';
      healthNote.textContent = `Focus data health: ${model.focusHealth.stale} classification${model.focusHealth.stale === 1 ? '' : 's'} out of date, ${model.focusHealth.unmapped} outcome${model.focusHealth.unmapped === 1 ? '' : 's'} not yet classified.`;
      overview.appendChild(healthNote);
    }
    body.appendChild(overview);

    const toggle = handlers.onFocusToggle || function () {};
    const reprioritise = handlers.onFocusPriority || function () {};
    const toggleSection = handlers.onFocusSectionToggle || function () {};
    const toggleCompleted = handlers.onFocusCompletedToggle || function () {};
    const openCategories = Array.isArray(model.focusOpenCategories)
      ? model.focusOpenCategories
      : [];
    const openCompletedCategories = Array.isArray(model.focusOpenCompletedCategories)
      ? model.focusOpenCompletedCategories
      : [];

    function isCompletedUnchosen(sel) {
      return sel.remainingLabel === 'complete' && sel.priority === null;
    }

    function appendSelectionRow(parent, category, sel) {
      const row = doc.createElement('div');
      row.className = 'tes-focus-row';
      const completedUnchosen = isCompletedUnchosen(sel);
      if (completedUnchosen) {
        row.setAttribute('data-disabled', 'true');
        row.setAttribute('title', 'This focus is already complete and cannot be selected.');
      }

      const box = doc.createElement('input');
      box.setAttribute('type', 'checkbox');
      // A single control either way: toggleFocus reads the player's current
      // focuses to decide select, deselect or swap, so every checkbox that is
      // still actionable commits through the same call.
      if (sel.priority !== null) box.checked = true;
      if (completedUnchosen) box.disabled = true;
      if (!completedUnchosen && box.addEventListener) {
        box.addEventListener('change', function () { toggle(category, sel.selection); });
      }
      row.appendChild(box);

      const label = doc.createElement('span');
      label.className = 'tes-focus-name';
      label.textContent = sel.selection;
      row.appendChild(label);

      const remaining = doc.createElement('span');
      remaining.className = 'tes-focus-remaining';
      remaining.textContent = sel.remainingLabel;
      row.appendChild(remaining);

      parent.appendChild(row);
    }

    for (const group of model.focusGroups) {
      const expanded = openCategories.indexOf(group.category) !== -1;
      const chosen = group.selections.find(function (sel) {
        return sel.priority !== null;
      }) || null;
      const section = focusSection(doc, body, group.category, group.selections, chosen, expanded, function () {
        toggleSection(group.category);
      }, function (selection, position) {
        reprioritise(group.category, selection, position);
      });
      if (!expanded) continue;
      const completed = group.selections.filter(isCompletedUnchosen);
      // A completed chosen focus stays in the main list: it is the category's
      // active plan, the header names it, and its live checkbox is the only
      // control that can untick it. Hiding that control behind a disclosure
      // the player has no reason to open would make the choice look permanent.
      const remaining = group.selections.filter(function (sel) {
        return !isCompletedUnchosen(sel);
      });
      for (const sel of remaining) appendSelectionRow(section, group.category, sel);

      // No empty disclosure: a button that opens onto nothing promises an
      // action it cannot perform.
      if (completed.length > 0) {
        const completedExpanded = openCompletedCategories.indexOf(group.category) !== -1;
        const completedGroup = doc.createElement('div');
        completedGroup.className = 'tes-focus-completed';
        const completedHeading = doc.createElement('button');
        completedHeading.className = 'tes-focus-completed-title';
        completedHeading.textContent = `completed (${completed.length})`;
        completedHeading.setAttribute('aria-expanded', completedExpanded ? 'true' : 'false');
        if (completedHeading.addEventListener) {
          completedHeading.addEventListener('click', function () { toggleCompleted(group.category); });
        }
        completedGroup.appendChild(completedHeading);
        if (completedExpanded) {
          for (const sel of completed) appendSelectionRow(completedGroup, group.category, sel);
        }
        section.appendChild(completedGroup);
      }
    }
  }

  // One box per degree, each answering the same question independently: if I
  // did only this, starting now, when would it finish? The all-remaining
  // total answers that same question for everything at once, so it renders
  // as its own full-width banner before the grid rather than as a thirteenth
  // cell inside it — a box among boxes reads as one more degree, not the
  // total. Every name here is Torn's, so every one goes in through
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

    // Its own full-width banner above the list, not a row inside it: the total
    // is not one of the degrees, and sitting among them it would read as one.
    const banner = doc.createElement('div');
    banner.className = 'tes-all-banner';
    const bannerTitle = doc.createElement('div');
    bannerTitle.className = 'tes-all-title';
    bannerTitle.textContent = model.grid.allBox.name;
    banner.appendChild(bannerTitle);
    const bannerFigures = doc.createElement('div');
    bannerFigures.className = 'tes-all-figures';
    const bannerMeta = doc.createElement('div');
    bannerMeta.className = 'tes-all-meta';
    bannerMeta.textContent = model.grid.allBox.courseCount === 0
      ? 'No courses remaining'
      : `${model.grid.allBox.courseCount} crs · ${model.grid.allBox.durationLabel}`;
    bannerFigures.appendChild(bannerMeta);
    const bannerFinish = doc.createElement('div');
    bannerFinish.className = 'tes-all-finish';
    bannerFinish.textContent = model.grid.allBox.courseCount === 0
      ? 'Already complete'
      : model.grid.allBox.finishLabel;
    bannerFigures.appendChild(bannerFinish);
    banner.appendChild(bannerFigures);
    body.appendChild(banner);

    const list = doc.createElement('div');
    list.className = 'tes-degree-list';
    for (const box of model.grid.boxes) {
      const row = doc.createElement('div');
      row.className = box.courseCount === 0
        ? 'tes-degree-row tes-degree-complete'
        : 'tes-degree-row';
      const main = doc.createElement('div');
      main.className = 'tes-degree-main';
      const identity = doc.createElement('div');
      identity.className = 'tes-degree-identity';
      identity.textContent = box.bachelorPrefix ? `${box.name} (${box.bachelorPrefix})` : box.name;
      main.appendChild(identity);
      if (box.courseCount !== 0) {
        const detail = doc.createElement('div');
        detail.className = 'tes-degree-detail';
        detail.textContent = `${box.courseCount} crs · ${box.durationLabel}`;
        main.appendChild(detail);
      }
      row.appendChild(main);
      const date = doc.createElement('div');
      date.className = 'tes-degree-date';
      date.textContent = box.courseCount === 0 ? 'Already complete' : box.finishLabel;
      row.appendChild(date);
      list.appendChild(row);
    }
    body.appendChild(list);

    // The number on this screen that looks wrong every time: eleven degrees
    // dated 2026 above an all-courses box dated 2029. Every box starts from
    // today by design, so the dates overlap and cannot be read in sequence.
    // The durations, though, do add up to the second — so the note explains
    // the date with that rather than denying it.
    const overlap = doc.createElement('div');
    overlap.className = 'tes-note';
    overlap.textContent = "The dates overlap: each starts from today, as if you did that degree and nothing else, so they cannot be read as a sequence. The durations do add up — that is why doing all of them lands on the all-courses box's date, years past any single degree.";
    body.appendChild(overlap);

    // Silent today: Torn keeps a course's prerequisites inside its own
    // category, so the boxes do sum and this line does not appear. It is here
    // for the catalogue where they stop doing that, so nobody adds the boxes
    // up, gets a bigger number and concludes the tool is broken.
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
    if (model.presetError) {
      const presetError = doc.createElement('div');
      presetError.className = 'tes-error';
      presetError.textContent = model.presetError;
      body.appendChild(presetError);
    }
    if (model.queueNotice) {
      const queueNotice = doc.createElement('div');
      queueNotice.className = 'tes-note tes-queue-notice';
      queueNotice.textContent = model.queueNotice;
      body.appendChild(queueNotice);
    }

    const overview = doc.createElement('div');
    overview.className = 'tes-overview tes-schedule-overview';

    // The finish date is the number this whole tool exists to produce, so
    // it gets its own prominent line rather than sitting mid-paragraph in
    // the summary below.
    if (model.finishLabel) {
      const finish = doc.createElement('div');
      finish.className = 'tes-finish';
      finish.textContent = `Queue fin: ${model.finishLabel}`;
      overview.appendChild(finish);
    }

    // Null whenever the finish date is withheld (buildPanelModel), so this
    // block never appears beside a queue that cannot be followed.
    if (model.consumables) {
      const c = model.consumables;
      const boost = doc.createElement('div');
      boost.className = 'tes-boosters';
      const scenario = function (nameText, finishText, detailText) {
        const row = doc.createElement('div');
        row.className = 'tes-booster-row';
        const name = doc.createElement('div');
        name.className = 'tes-booster-name';
        name.textContent = nameText;
        row.appendChild(name);
        const finish = doc.createElement('div');
        finish.className = 'tes-booster-finish';
        finish.textContent = finishText;
        row.appendChild(finish);
        const detail = doc.createElement('div');
        detail.className = 'tes-booster-detail';
        detail.textContent = detailText;
        row.appendChild(detail);
        boost.appendChild(row);
      };
      // First, because it is first in the arithmetic: the Books lines below
      // are computed against the path this one leaves behind, not against the
      // raw queue total. Rendering them the other way round would read as two
      // independent savings off the same number.
      if (c.jobPoints > 0) {
        scenario(
          `${c.jobPoints} job point${c.jobPoints === 1 ? '' : 's'}`,
          c.jobPointFinishLabel,
          `30 minutes each · ${c.jobPointDurationLabel}`
        );
      }
      if (c.plannedBooks > 0) {
        scenario(
          `${c.plannedBooks} Book${c.plannedBooks === 1 ? '' : 's'} owned`,
          c.plannedFinishLabel,
          `Planned from what you have · ${c.plannedDurationLabel}`
        );
      }
      // The cost is not decoration. A floor date without it is a number
      // nobody can act on — and "$0", which is what an unset price would
      // arithmetically produce, is worse than no figure at all: it reads as
      // "the floor is free". Name the gap instead, and say how to close it.
      const costText = c.floorCostLabel || 'cost unknown, no Book price set';
      scenario(
        'Maximum Books floor',
        c.floorFinishLabel,
        `${c.floorBooks} Books · ${costText} · ${model.settings.maxCooldownHours}hr CD · ${c.floorDurationLabel}`
      );
      if (!c.floorCostLabel) {
        const priceNote = doc.createElement('div');
        priceNote.className = 'tes-note tes-booster-note';
        priceNote.textContent = 'Set a Book price in settings to see what that floor would cost.';
        boost.appendChild(priceNote);
      }
      const caveat = doc.createElement('div');
      caveat.className = 'tes-note tes-booster-note';
      caveat.textContent = 'Job points apply first; Book figures use the time left after them. Both shorten queued course time. Time already running on your current course is not affected.';
      boost.appendChild(caveat);
      overview.appendChild(boost);
    }

    // Three real child elements, not one text node joined with '\n', so each
    // part can be styled and asserted on independently. Each piece is set
    // through textContent only; course names come from Torn and are not ours
    // to trust into markup.
    //
    // The second class is what carries the separator under the whole block —
    // see .tes-summary-queue in panelStyleText. .tes-summary alone is shared
    // with three other blocks that must not gain a border.
    const summary = doc.createElement('div');
    summary.className = 'tes-summary tes-summary-queue';

    const inputs = doc.createElement('div');
    inputs.className = 'tes-summary-inputs';
    inputs.textContent = `Perk reduction: ${model.reductionLabel}`;
    summary.appendChild(inputs);

    const result = doc.createElement('div');
    result.className = 'tes-summary-result';
    if (model.finishLabel) {
      result.textContent = `Total queued time: ${model.totalLabel}`;
    } else if (model.queue.length === 0) {
      result.textContent = 'Queue is empty. Add a course below.';
    } else {
      // finishLabel is withheld (buildPanelModel) whenever problems is
      // non-empty — a queue with unmet prerequisites is not a plan the
      // player can actually follow, so no total is safe to print. The
      // per-course detail lands below via the diagnostics block.
      result.textContent = 'This queue cannot be followed as ordered — missing prerequisites below.';
    }
    summary.appendChild(result);

    // Rendered only when there is something to diagnose, so a clean queue's
    // summary is exactly two sections and nothing hints at a problem that
    // does not exist.
    if (model.stale.length || model.problems.length) {
      const diagnostics = doc.createElement('div');
      diagnostics.className = 'tes-summary-diagnostics';
      const diagLines = [];
      for (const entry of model.stale) {
        diagLines.push(`Removed ${entry.prefix || entry.courseId} from your queue — ${entry.why}.`);
      }
      for (const problem of model.problems) {
        diagLines.push(`${problem.prefix} needs ${problem.missing.map(function (m) { return m.prefix; }).join(', ')}`);
      }
      diagnostics.textContent = diagLines.join('\n');
      summary.appendChild(diagnostics);
    }

    overview.appendChild(summary);
    body.appendChild(overview);

    // Two compact lines per queued course, sharing one grid row with the remove
    // button: identity first, then timing and the bonus in one secondary line.
    // Torn owns both name and bonus, so both wrap and both use textContent.
    for (const item of model.queue) {
      const row = doc.createElement('div');
      row.className = 'tes-queue-row';
      const reorder = doc.createElement('div');
      reorder.className = 'tes-reorder';
      const moveButton = function (direction, allowed, title) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = `tes-move tes-move-${direction}`;
        button.title = title;
        button.setAttribute('aria-label', `Move ${item.prefix} ${direction}`);
        if (!allowed) {
          button.disabled = true;
          button.setAttribute('aria-disabled', 'true');
        } else if (button.addEventListener && handlers.onMove) {
          button.addEventListener('click', function () { handlers.onMove(item.courseId, direction); });
        }
        const chevron = doc.createElement('span');
        chevron.className = `tes-chevron tes-chevron-${direction}`;
        chevron.setAttribute('aria-hidden', 'true');
        button.appendChild(chevron);
        return button;
      };
      reorder.appendChild(moveButton('up', item.canMoveUp === true, item.moveUpTitle));
      reorder.appendChild(moveButton('down', item.canMoveDown === true, item.moveDownTitle));
      row.appendChild(reorder);
      const main = doc.createElement('span');
      main.className = 'tes-queue-main';
      main.textContent = `${item.prefix} · ${item.name}`;
      row.appendChild(main);
      const detail = doc.createElement('span');
      detail.className = 'tes-queue-detail';
      detail.textContent = `${item.durationLabel} · fin ${item.finishLabel} · ${item.bonusLabel}`;
      row.appendChild(detail);
      const remove = doc.createElement('button');
      remove.className = 'tes-remove-course';
      remove.textContent = 'remove';
      remove.dataset.courseId = String(item.courseId);
      if (remove.addEventListener) {
        remove.addEventListener('click', function () { handlers.onRemove(item.courseId); });
      }
      row.appendChild(remove);
      body.appendChild(row);
    }

    const picker = doc.createElement('select');
    picker.className = 'tes-course-picker';
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
    const presetGroup = doc.createElement('optgroup');
    presetGroup.label = 'Guide presets';
    for (const preset of model.guidePresets || []) {
      const opt = doc.createElement('option');
      opt.value = preset.value;
      opt.textContent = preset.label;
      opt.className = 'tes-option-preset';
      // Fully represented presets are filtered out by buildPanelModel.
      if (model.selectedCourseId === preset.value) opt.selected = true;
      presetGroup.appendChild(opt);
    }
    if (presetGroup.children.length > 0) picker.appendChild(presetGroup);
    // Kept near the top, below the five guide presets, but never the default.
    // Only when there is something left to add: an entry reading
    // "all remaining (0)" invites a click that can do nothing.
    if (model.addable.length > 0) {
      const allOpt = doc.createElement('option');
      allOpt.value = ALL_COURSES_OPTION;
      // Deliberately unabbreviated — see the rule above formatDuration. This
      // is prose in a full-width dropdown, not a dense readout, and it is
      // meant to read the same as the all-remaining banner's own title.
      allOpt.textContent = `— all remaining courses (${model.addable.length}) —`;
      if (model.selectedCourseId === ALL_COURSES_OPTION) allOpt.selected = true;
      picker.appendChild(allOpt);
    }
    for (const option of model.addable) {
      const opt = doc.createElement('option');
      opt.value = String(option.courseId);
      // The bachelor marker is a class, not text in the label — see the
      // `.tes-option-bachelor` rule in panelStyleText for the colour and the
      // accepted macOS trade. textContent, never innerHTML.
      opt.textContent = option.label;
      if (option.isBachelor) opt.className = 'tes-option-bachelor';
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
        const preset = guidePresetForValue(picker.value);
        if (preset) { handlers.onAddPreset(preset.key); return; }
        const chosen = Number(picker.value);
        if (Number.isInteger(chosen)) handlers.onAdd(chosen);
      });
    }
    body.appendChild(picker);
    body.appendChild(add);

    // One unobtrusive line: a player who needs the guide will not go looking
    // in settings for it, but the schedule view must not become an advert.
    // An unresolved URL renders nothing at all, exactly as in the settings view.
    if (isResolvedUrl(FORUM_POST_URL)) {
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
  const DOM_READY_POLL_MS = 50;
  const DOM_READY_MAX_POLLS = 300;

  function whenDocumentReady(doc, win, onReady) {
    let finished = false;
    let timer = null;
    let polls = 0;

    function hasUsableDom() {
      try { return !!(doc && doc.documentElement && doc.body); }
      catch (e) { return false; }
    }

    function cleanup() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('DOMContentLoaded', check);
      }
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('load', check);
      }
    }

    function finish() {
      if (finished) return;
      finished = true;
      cleanup();
      try { onReady(); } catch (e) { /* startup failures must not escape onto Torn's page */ }
    }

    function check() {
      if (finished) return;
      if (hasUsableDom()) {
        finish();
        return;
      }
      if (polls >= DOM_READY_MAX_POLLS) {
        finished = true;
        cleanup();
        return;
      }
      if (timer === null) {
        polls += 1;
        timer = setTimeout(function () {
          timer = null;
          check();
        }, DOM_READY_POLL_MS);
      }
    }

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('DOMContentLoaded', check);
    }
    if (win && typeof win.addEventListener === 'function') win.addEventListener('load', check);
    check();
    return function stopWaiting() {
      if (finished) return;
      finished = true;
      cleanup();
    };
  }

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
          const original = history[name];
          const patched = function () {
            const result = original.apply(this, arguments);
            notify();
            return result;
          };
          // Some embedded webviews expose History methods as immutable native
          // bindings. Treat patching as an optional signal: popstate and the
          // MutationObserver still work, and initial mounting must never abort
          // because assigning one of these properties throws in strict mode.
          try {
            history[name] = patched;
            if (history[name] === patched) originals[name] = original;
          } catch (e) { /* immutable PDA history method */ }
        }
      }
    }

    if (typeof win.addEventListener === 'function') {
      try { win.addEventListener('popstate', notify); } catch (e) { /* optional navigation signal */ }
    }

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
        for (const name of Object.keys(originals)) {
          try { history[name] = originals[name]; } catch (e) { /* immutable after installation */ }
        }
      }
      if (typeof win.removeEventListener === 'function') {
        try { win.removeEventListener('popstate', notify); } catch (e) { /* already unavailable */ }
      }
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
      queue: [], addable: [], guidePresets: [], stale: [], problems: [], finishLabel: null, totalLabel: null,
      collapsed: false, saveError: false, selectedCourseId: null, view: 'schedule',
      presetError: null, queueNotice: null,
      // Every field below is filled even where nothing currently reads it, so
      // that a renderer handed this model can never meet an undefined. The real
      // orderModes list rather than an empty one, for the same reason: an empty
      // one would draw an optionless dropdown.
      settings: normaliseSettings(null), settingsSaveError: false,
      perkInference: NO_INFERENCE, orderModes: ORDER_MODE_LABELS, debugReport: null, grid: null,
      focusGroups: null, focuses: null, focusHealth: null, focusOpenCategories: [],
      focusOpenCompletedCategories: [],
      consumables: null,
      summaryAvailable: false, summaryReason: PATH_SUMMARY_REASONS.noData, summaryOpen: false, pathSummary: null,
      shareText: '', importError: null,
    };
  }

  function loadingModel() {
    const model = errorModel('Loading education data…');
    model.status = 'loading';
    return model;
  }

  const noopHandlers = {
    onToggle: function () {}, onAdd: function () {}, onRemove: function () {}, onMove: function () {},
    onAddAll: function () {}, onAddPreset: function () {},
    onPickerChange: function () {}, onViewChange: function () {},
    onSettingChange: function () {},
    onToggleDebugReport: function () {}, onCopyDebugReport: function () {},
    // renderFocusView (reachable only via renderPanel's view dispatch, which
    // guards its own calls with `|| function(){}`) does not strictly need
    // these to exist here — but every other handler renderSettingsView calls
    // is kept for shape completeness, and these are the same kind of caller.
    onFocusToggle: function () {}, onFocusPriority: function () {}, onFocusSectionToggle: function () {},
    onFocusCompletedToggle: function () {},
    onFocusRankToggle: function () {},
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

    // The design requires the panel to be visible even when Torn's markup
    // does not match any known mount selector, rather than rendering
    // nothing with no explanation.
    //
    // findMountPoint runs our selectors against a document we do not control,
    // and init() is now called again on every route change rather than once at
    // load. An unguarded throw here becomes an unhandled rejection and the page
    // goes blank with no hint why — the same failure draw()'s try/catch below
    // already exists to prevent, so the discipline extends to this phase too.
    let mountResult = resolvePanelMount(document);
    let mount = mountResult.mount;
    let mountError = mountResult.error;
    if (!mount) return null;

    // Give PDA and slow connections an immediate, visible execution signal.
    // The inert shell writes no storage and offers no navigation controls; the
    // same mount is redrawn with real data and handlers after acquisition.
    try {
      if (mountError !== null) {
        return renderPanel(document, mount,
          errorModel(`Education Scheduler could not read the page: ${mountError}`), noopHandlers);
      }
      renderPanel(document, mount, loadingModel(), noopHandlers);
    } catch (e) {
      return null;
    }

    // Two acquisition paths: the endpoint, then Torn's own React tree. The
    // panel keeps calling this value fetchResult because buildPanelModel's
    // contract has not changed — only where the data may have come from.
    const fetchResult = await acquireEducationData(document);

    // Torn may replace its content host while the request is in flight. Resolve
    // the live host again so the final panel never lands in a detached tree;
    // resolvePanelMount reuses the owned fallback instead of stacking another.
    mountResult = resolvePanelMount(document);
    if (!mountResult.mount) return null;
    mount = mountResult.mount;
    mountError = mountResult.error;

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
      if (!data) return false;
      const inference = inferPerks(data.reduction);
      if (!inference.determinate) return false;
      let changed = false;
      const next = JSON.parse(JSON.stringify(settings));
      if (next.perks.meritsPercent === null) { next.perks.meritsPercent = inference.meritsPercent; changed = true; }
      if (next.perks.principal === null) { next.perks.principal = inference.principal; changed = true; }
      if (next.perks.wsuBlock === null) { next.perks.wsuBlock = inference.wsuBlock; changed = true; }
      if (!changed) return false;
      // normaliseSettings is the only writer of the canonical shape.
      settings = normaliseSettings(next);
      return true;
    }
    if (prefillPerks(fetchResult.ok ? fetchResult.data : null)) {
      settingsSaveFailed = !saveSettings(settings);
    }

    let selectedCourseId = null;
    // One failed preset action, shown on Schedule and never persisted. A later
    // action clears it so an old catalogue mismatch cannot follow the player
    // around after they have moved on.
    let presetError = null;
    // A manual move materialises the currently visible order and changes the
    // ordering preference to As listed. Name that one automatic setting change
    // on the resulting schedule so the Focus button disappearing is explained.
    let queueNotice = null;
    // Built on demand and never persisted: it is a snapshot of one moment's
    // failure, and a stale one pasted into a forum thread describes a bug
    // nobody is looking at any more.
    let debugReport = null;
    // Held in this closure, not persisted: collapsed is a standing preference,
    // but which view you last opened is not. A player who hides the panel wants
    // it hidden next visit; a player who opened settings once does not want
    // settings every visit.
    let view = 'schedule';
    // Focus sections are transient disclosure state. Entering the view starts
    // closed every time, while an in-view heading click redraws just its own
    // category open or closed without writing either storage key.
    let focusOpenCategories = [];
    // Nested completed groups use the same transient lifetime as their parent
    // categories. They reset on every entry to Focus and are never persisted.
    let focusOpenCompletedCategories = [];
    // Cleared by the next successful import, never persisted: it describes one
    // paste, and a stale reason beside a plan that imported fine is a lie.
    let importError = null;
    // The reset control's arm/confirm state. Held here, not in plan or
    // settings, and never written through savePlan/saveSettings —
    // every other handler sets this false before doing its own work, which
    // is what makes a view change, a collapse, or any other click disarm it.
    // A panel reopened later must never be found armed.
    let resetArmed = false;

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
          presetError: presetError,
          queueNotice: queueNotice,
          view: view,
          debugReport: debugReport,
          importError: importError,
          resetArmed: resetArmed,
          focusOpenCategories: focusOpenCategories,
          focusOpenCompletedCategories: focusOpenCompletedCategories,
        });

        function commit(next) {
          const saved = savePlan(next);
          draw(next, !saved);
        }

        return renderPanel(document, mount, model, {
          onToggle: function () {
            resetArmed = false;
            presetError = null;
            commit({ queue: currentPlan.queue, collapsed: !currentPlan.collapsed });
          },
          onAdd: function (courseId) {
            resetArmed = false;
            presetError = null;
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
            resetArmed = false;
            presetError = null;
            const data = fetchResult.ok ? fetchResult.data : null;
            if (!data) return;
            const everything = allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
            const toAdd = everything.filter(function (id) { return currentPlan.queue.indexOf(id) === -1; });
            if (toAdd.length === 0) return;
            commit({ queue: currentPlan.queue.concat(toAdd), collapsed: currentPlan.collapsed });
          },
          onAddPreset: function (presetKey) {
            resetArmed = false;
            const data = fetchResult.ok ? fetchResult.data : null;
            if (!data) return;
            const expansion = expandGuidePreset(
              presetKey, data.completedIds, data.courses, data.activeCourse, currentPlan.queue
            );
            if (!expansion.ok) {
              let label = String(presetKey);
              for (const preset of GUIDE_PRESETS) {
                if (preset.key === presetKey) { label = preset.label; break; }
              }
              presetError = `Couldn't add ${label} — ${expansion.detail}.`;
              draw(currentPlan, saveFailed === true);
              return;
            }
            presetError = null;
            if (expansion.courseIds.length === 0) {
              draw(currentPlan, saveFailed === true);
              return;
            }
            commit({
              queue: currentPlan.queue.concat(expansion.courseIds),
              collapsed: currentPlan.collapsed,
            });
          },
          onRemove: function (courseId) {
            resetArmed = false;
            presetError = null;
            commit({
              queue: currentPlan.queue.filter(function (id) { return id !== courseId; }),
              collapsed: currentPlan.collapsed,
            });
          },
          onMove: function (courseId, direction) {
            resetArmed = false;
            presetError = null;
            queueNotice = null;
            const data = fetchResult.ok ? fetchResult.data : null;
            if (!data) return;
            // Move what the player can see. Under an automatic mode that order
            // can differ from storage, so a successful first move materialises
            // the visible queue before As listed takes over.
            const visibleQueue = model.queue.map(function (item) { return item.courseId; });
            const moved = moveQueueCourse(visibleQueue, courseId, direction, data.courses);
            if (!moved.ok) return;
            if (settings.orderMode !== 'as-listed') {
              const nextSettings = JSON.parse(JSON.stringify(settings));
              nextSettings.orderMode = 'as-listed';
              const normalised = normaliseSettings(nextSettings);
              const saved = saveSettings(normalised);
              settingsSaveFailed = !saved;
              if (!saved) {
                draw(currentPlan, saveFailed === true);
                return;
              }
              settings = normalised;
              queueNotice = 'Queue order changed to As listed for manual reordering.';
            }
            commit({ queue: moved.queue, collapsed: currentPlan.collapsed });
          },
          onPickerChange: function (value) {
            resetArmed = false;
            presetError = null;
            // The sentinel is preserved rather than coerced: Number('__all__')
            // is NaN, so the integer guard below would reset the picker to the
            // top of the list on the next redraw.
            if (value === ALL_COURSES_OPTION) { selectedCourseId = ALL_COURSES_OPTION; return; }
            const preset = guidePresetForValue(value);
            if (preset) { selectedCourseId = preset.value; return; }
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
            resetArmed = false;
            presetError = null;
            // The focus button is absent outside focus ordering, but callers
            // can still invoke this route directly. Keep that route from
            // stranding the panel on a view whose entry is unavailable.
            const nextView = next === 'focus' && settings.orderMode !== 'focus' ? 'schedule' : next;
            if (nextView === 'focus' && view !== 'focus') {
              focusOpenCategories = [];
              focusOpenCompletedCategories = [];
            }
            view = nextView;
            draw(currentPlan, saveFailed === true);
          },
          // The view emits dotted `perks.*` paths for the nested group and a
          // bare field name for the rest. An empty number input means "not
          // said" (null), which for a perk is distinct from zero.
          onSettingChange: function (field, rawValue) {
            resetArmed = false;
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
            resetArmed = false;
            const next = JSON.parse(JSON.stringify(settings));
            next.focuses = toggleFocus(settings.focuses, category, selection);
            settings = normaliseSettings(next);
            settingsSaveFailed = !saveSettings(settings);
            draw(currentPlan, saveFailed === true);
          },
          onFocusRankToggle: function () {
            resetArmed = false;
            const next = JSON.parse(JSON.stringify(settings));
            next.focusRankBasis = settings.focusRankBasis === 'per-day' ? 'total' : 'per-day';
            settings = normaliseSettings(next);
            settingsSaveFailed = !saveSettings(settings);
            draw(currentPlan, saveFailed === true);
          },
          onFocusPriority: function (category, selection, position) {
            resetArmed = false;
            const next = JSON.parse(JSON.stringify(settings));
            next.focuses = setFocusPriority(settings.focuses, category, selection, position);
            settings = normaliseSettings(next);
            settingsSaveFailed = !saveSettings(settings);
            draw(currentPlan, saveFailed === true);
          },
          onFocusSectionToggle: function (category) {
            resetArmed = false;
            const index = focusOpenCategories.indexOf(category);
            focusOpenCategories = index === -1
              ? focusOpenCategories.concat(category)
              : focusOpenCategories.filter(function (openCategory) { return openCategory !== category; });
            draw(currentPlan, saveFailed === true);
          },
          onFocusCompletedToggle: function (category) {
            resetArmed = false;
            const index = focusOpenCompletedCategories.indexOf(category);
            focusOpenCompletedCategories = index === -1
              ? focusOpenCompletedCategories.concat(category)
              : focusOpenCompletedCategories.filter(function (openCategory) { return openCategory !== category; });
            draw(currentPlan, saveFailed === true);
          },
          onToggleDebugReport: function () {
            resetArmed = false;
            debugReport = debugReport
              ? null
              : buildDebugReport(gatherDebugContext({ fetchResult: fetchResult, plan: currentPlan, settings: settings }));
            draw(currentPlan, saveFailed === true);
          },
          onCopyDebugReport: function () {
            resetArmed = false;
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
            resetArmed = false;
            const data = fetchResult.ok ? fetchResult.data : null;
            if (!data) { importError = 'No course data loaded, so a plan cannot be checked.'; draw(currentPlan, saveFailed === true); return; }
            const decoded = decodePlan(text, data.courses);
            if (!decoded.ok) {
              importError = `Couldn't import that plan (${decoded.reason}: ${decoded.detail}).`;
              draw(currentPlan, saveFailed === true);
              return;
            }
            importError = null;
            settings = decoded.settings;
            settingsSaveFailed = !saveSettings(settings);
            commit({ queue: decoded.queue, collapsed: currentPlan.collapsed });
          },
          // One pair of handlers, not three: model.view already decides what
          // gets cleared, so there is one place that decides and no way for
          // the button and the action to disagree about which page they are
          // on. Arming never touches storage — only a confirm does, and only
          // through the same commit/saveSettings paths every other mutation
          // uses, so a failed write surfaces exactly the way it would there.
          onResetArm: function () {
            resetArmed = true;
            draw(currentPlan, saveFailed === true);
          },
          onResetConfirm: function () {
            resetArmed = false;
            presetError = null;
            if (view === 'schedule') {
              commit({ queue: [], collapsed: currentPlan.collapsed });
              return;
            }
            if (view === 'settings') {
              settings = settingsDefaults(settings);
              prefillPerks(fetchResult.ok ? fetchResult.data : null);
              settingsSaveFailed = !saveSettings(settings);
              draw(currentPlan, saveFailed === true);
              return;
            }
            if (view === 'focus') {
              // Priority is the array index, not a stored field — clearing
              // focuses to [] removes every number with it. Same
              // normalise/save/redraw commit onFocusToggle uses, so a failed
              // write surfaces as settingsSaveFailed rather than being lost.
              const next = Object.assign({}, settings, { focuses: [] });
              settings = normaliseSettings(next);
              settingsSaveFailed = !saveSettings(settings);
              draw(currentPlan, saveFailed === true);
              return;
            }
            // No other view is reset-armable; redraw disarms the button
            // regardless, so a stray confirm here is inert rather than stuck
            // armed.
            draw(currentPlan, saveFailed === true);
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

  function shouldMoveFallbackInline() {
    if (queryOne(document, '#tes-fallback-mount') === null) return false;
    try { return findMountPoint(document) !== null; }
    catch (e) { return false; }
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
    if (mounted && panelPresent() && !shouldMoveFallbackInline()) return;
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

  whenDocumentReady(document, window, function () {
    // Draw first. Navigation hooks are resilience for later SPA transitions,
    // not a prerequisite for the current page; a PDA-specific hook failure
    // must not suppress the one mount the player is waiting to see.
    syncToRoute();
    observeNavigation(document, window, { onRouteChange: scheduleSync });
  });
})();
