// ==UserScript==
// @name         Torn Education Scheduler
// @namespace    https://github.com/DaftVino/torn-education-scheduler
// @version      0.1.0
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

  const SCRIPT_VERSION = '0.1.0';
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
  // Only the course `activeCourse` actually names is promoted, and only when
  // Torn gave us its completion time. `status` and `activeCourse` come from
  // independent parts of the payload: a course marked inProgress that
  // activeCourse does not name has no completion time anywhere, so schedule()
  // bills none of its remaining weeks. Promoting it would print a finish date
  // short by up to a whole course. Refusing to promote it costs only the
  // withheld date the panel would have shown before any of this existed, which
  // is the trade this codebase makes every time: no date beats a wrong one.
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

  // actualDuration already carries the player's perk reduction, so the base
  // case is a sum. Timestamps are Unix seconds throughout, matching
  // activeCourse.completedAt.
  //
  // Order does not change finishesAt — a sum is order-independent. Ordering
  // changes time-to-benefit, which is a different question and a later
  // release. tests/engine.test.js asserts this property directly.
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

  const ORDER_MODES = ['as-listed', 'shortest-first', 'unlocks-first'];
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
    };
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
  // back to a bounded sweep of the body's element children.
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

  function buildPanelModel(state) {
    const empty = {
      status: 'error', message: null, reductionLabel: null,
      queue: [], addable: [], stale: [], problems: [], finishLabel: null, totalLabel: null,
      collapsed: state.plan.collapsed === true,
      saveError: state.saveFailed === true,
      selectedCourseId: state.selectedCourseId != null ? state.selectedCourseId : null,
      view: state.view || 'schedule',
      settings: panelSettings(state),
      settingsSaveError: state.settingsSaveFailed === true,
      perkInference: NO_INFERENCE,
      // Task 10 replaces this with the real orderings.
      orderModes: [{ id: 'as-listed', label: 'As listed' }],
      // Null until the player asks for it. An acquisition failure is exactly
      // when the report is most wanted — and it is genuinely reachable from
      // here: renderPanel no longer returns before the nav row on an error
      // model, so the settings view (which owns the report) can be opened.
      // This is the only path on which failureReason/failureDetail are
      // populated at all, so if it stops being reachable the report's whole
      // Failure block silently becomes "not recorded".
      debugReport: state.debugReport || null,
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
    const queue = state.plan.queue.filter(function (id) {
      const course = data.courses.get(id);
      if (!course) { stale.push({ courseId: id, why: 'no longer in the catalogue' }); return false; }
      if (course.status === 'completed') { stale.push({ courseId: id, prefix: course.prefix, why: 'already completed' }); return false; }
      if (course.status === 'inProgress') { stale.push({ courseId: id, prefix: course.prefix, why: 'currently in progress' }); return false; }
      return true;
    });
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
    const inference = inferPerks(data.reduction);
    const perkInference = {
      determinate: inference.determinate,
      totalPercent: inference.totalPercent,
      note: inference.determinate
        ? `Inferred from your ${inference.totalPercent}% reduction: this total has only one possible combination. Correct it if it is wrong.`
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
      settings: panelSettings(state),
      settingsSaveError: state.settingsSaveFailed === true,
      perkInference: perkInference,
      // Task 10 replaces this with the real orderings.
      orderModes: [{ id: 'as-listed', label: 'As listed' }],
      debugReport: state.debugReport || null,
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
  const VIEW_TITLES = { schedule: 'Education Scheduler', settings: 'Settings', grid: 'Degrees' };

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
        for (const target of ['schedule', 'grid', 'settings']) {
          if (target === view) continue;
          const btn = doc.createElement('button');
          btn.textContent = target === 'settings' ? '⚙ settings' : target === 'grid' ? 'degrees' : 'schedule';
          if (btn.addEventListener && handlers.onViewChange) {
            btn.addEventListener('click', function () { handlers.onViewChange(target); });
          }
          nav.appendChild(btn);
        }
        body.appendChild(nav);
      }

      // Settings renders in full either way — it reads nothing from the
      // payload. Schedule and Degrees have nothing to draw without data, and
      // the failure line above is the whole of what they have to say, so they
      // are skipped rather than rendered empty.
      if (view === 'settings') renderSettingsView(doc, body, model, handlers);
      else if (model.status === 'error') { /* the failure line is the view */ }
      else if (view === 'grid') renderGridView(doc, body, model, handlers);
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
  }

  // Placeholder until Task 8 fills it in — a line of text rather than nothing,
  // because an empty view reads as a broken panel.
  function renderGridView(doc, body, model, handlers) {
    const line = doc.createElement('div');
    line.className = 'tes-summary';
    line.textContent = 'Degrees';
    body.appendChild(line);
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
      perkInference: NO_INFERENCE, orderModes: [], debugReport: null,
    };
  }

  const noopHandlers = {
    onToggle: function () {}, onAdd: function () {}, onRemove: function () {},
    onAddAll: function () {},
    onPickerChange: function () {}, onViewChange: function () {},
    onSettingChange: function () {},
    onToggleDebugReport: function () {}, onCopyDebugReport: function () {},
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
