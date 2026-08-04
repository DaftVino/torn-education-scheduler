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

  // ─── ENGINE START ───────────────────────────────────────────────
  // Pure functions only. No DOM, no network, no GM_*, no ambient clock.
  // Enforced by tests/purity.test.js — read that before adding anything here.

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
    if (!raw || raw.success !== true) throw PayloadError('not-a-payload');
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
    const activeCourse = active && isInt(active.id)
      ? { id: active.id, categoryId: active.category, name: active.name, completedAt: active.completedAt }
      : null;

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

    // Check only the immediate parent. validateQueue walks the queue and builds
    // up the done set, so later courses see earlier ones as satisfied.
    const parentId = course.parentId;
    if (parentId !== null && parentId !== undefined) {
      if (!completedIds.has(parentId)) {
        const parent = courses.get(parentId);
        if (!parent) {
          missing.add(-1);
        } else {
          missing.add(parent.id);
        }
      }
    }

    return [...missing].sort((a, b) => a - b);
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

  // ─── ENGINE END ─────────────────────────────────────────────────

  // ─── RUNTIME ────────────────────────────────────────────────────

  function isEducationPage() {
    return typeof location !== 'undefined'
      && location.pathname === '/page.php'
      && /(\?|&)sid=education(&|$)/.test(location.search || '');
  }

  // The guard wraps only the bootstrap, never the IIFE body. Torn Bookie's
  // harness documents the failure this avoids: if the whole body is guarded and
  // a test forgets location.search, the script early-returns, the export
  // injection never runs, and the test fails with no usable hint.
  if (isEducationPage()) {
    // bootstrap lands in Task 7
  }
})();
