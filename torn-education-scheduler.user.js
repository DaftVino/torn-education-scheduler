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

  // ─── ENGINE END ─────────────────────────────────────────────────

  // ─── RUNTIME ────────────────────────────────────────────────────

  const DEFAULT_PLAN = { queue: [], collapsed: false };

  // GM storage rather than localStorage: a plan can represent months of intent,
  // so it should survive a site-data clear and stay unreadable by torn.com's
  // own page scripts.
  function loadPlan() {
    let stored;
    try {
      stored = GM_getValue(STORAGE_KEY, null);
    } catch (e) {
      return { queue: [], collapsed: false };
    }
    if (typeof stored !== 'string') return { queue: [], collapsed: false };

    let parsed;
    try {
      parsed = JSON.parse(stored);
    } catch (e) {
      return { queue: [], collapsed: false };
    }
    if (!parsed || !Array.isArray(parsed.queue)) return { queue: [], collapsed: false };

    return {
      queue: parsed.queue.filter(function (id) { return Number.isInteger(id); }),
      collapsed: parsed.collapsed === true,
    };
  }

  function savePlan(plan) {
    try {
      GM_setValue(STORAGE_KEY, JSON.stringify({
        queue: (plan.queue || []).filter(function (id) { return Number.isInteger(id); }),
        collapsed: plan.collapsed === true,
      }));
    } catch (e) {
      // Storage failure must not take the panel down with it.
    }
  }

  // Same-origin, so the session cookie rides along and no @connect is needed.
  // Always resolves: the panel must be able to say what went wrong, and a
  // rejected promise here would surface as a blank panel instead.
  async function fetchEducationData(fetchImpl) {
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return { ok: false, reason: 'network', detail: 'no fetch available' };

    let response;
    try {
      response = await doFetch(EDU_ENDPOINT, {
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

  function reductionLabel(reduction) {
    if (!reduction.constant || reduction.ratio === null) return 'varies by course';
    return `${Math.round((1 - reduction.ratio) * 100)}% off`;
  }

  function buildPanelModel(state) {
    const empty = {
      status: 'error', message: null, reductionLabel: null,
      queue: [], addable: [], stale: [], problems: [], finishLabel: null, totalLabel: null,
      collapsed: state.plan.collapsed === true,
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

    const problems = validateQueue(queue, data.completedIds, data.courses).map(function (problem) {
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
      addable.push({
        courseId: course.id,
        prefix: course.prefix,
        name: course.name,
        durationLabel: formatDuration(course.duration),
      });
    }
    addable.sort(function (a, b) { return a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0; });

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
      finishLabel: queue.length > 0 ? formatTimestamp(result.finishesAt) : null,
      totalLabel: queue.length > 0 ? formatDuration(result.totalSeconds) : null,
      collapsed: state.plan.collapsed === true,
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

  function renderPanel(doc, mount, model, handlers) {
    const existing = doc.querySelector('#tes-panel');
    if (existing && existing.remove) existing.remove();

    const panel = doc.createElement('div');
    panel.id = 'tes-panel';
    panel.setAttribute('data-tes-version', SCRIPT_VERSION);

    const header = doc.createElement('div');
    header.textContent = `Education Scheduler — ${model.collapsed ? 'show' : 'hide'}`;
    if (header.addEventListener) header.addEventListener('click', handlers.onToggle);
    panel.appendChild(header);

    if (!model.collapsed) {
      const body = doc.createElement('div');

      if (model.status === 'error') {
        body.textContent = model.message;
        panel.appendChild(body);
        mount.appendChild(panel);
        return panel;
      }

      const summary = doc.createElement('div');
      const lines = [`Perk reduction: ${model.reductionLabel}`];
      if (model.finishLabel) {
        lines.push(`Queue finishes: ${model.finishLabel}`);
        lines.push(`Total queued time: ${model.totalLabel}`);
      } else {
        lines.push('Queue is empty. Add a course below.');
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
        const label = doc.createElement('span');
        label.textContent = `${item.prefix} ${item.name} — ${item.durationLabel} — done ${item.finishLabel}`;
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
      for (const option of model.addable) {
        const opt = doc.createElement('option');
        opt.value = String(option.courseId);
        opt.textContent = `${option.prefix} ${option.name} (${option.durationLabel})`;
        picker.appendChild(opt);
      }
      const add = doc.createElement('button');
      add.textContent = 'add';
      if (add.addEventListener) {
        add.addEventListener('click', function () {
          const chosen = Number(picker.value);
          if (Number.isInteger(chosen)) handlers.onAdd(chosen);
        });
      }
      body.appendChild(picker);
      body.appendChild(add);

      panel.appendChild(body);
    }

    mount.appendChild(panel);
    return panel;
  }

  async function init() {
    const plan = loadPlan();
    const fetchResult = await fetchEducationData(null);
    const mount = findMountPoint(document);
    if (!mount) return null;

    function draw(currentPlan) {
      const model = buildPanelModel({
        fetchResult: fetchResult,
        plan: currentPlan,
        now: Math.floor(Date.now() / 1000),
      });
      function commit(next) {
        savePlan(next);
        draw(next);
      }

      return renderPanel(document, mount, model, {
        onToggle: function () {
          commit({ queue: currentPlan.queue, collapsed: !currentPlan.collapsed });
        },
        onAdd: function (courseId) {
          if (currentPlan.queue.indexOf(courseId) !== -1) return;
          commit({ queue: currentPlan.queue.concat([courseId]), collapsed: currentPlan.collapsed });
        },
        onRemove: function (courseId) {
          commit({
            queue: currentPlan.queue.filter(function (id) { return id !== courseId; }),
            collapsed: currentPlan.collapsed,
          });
        },
      });
    }

    return draw(plan);
  }

  // The guard wraps only the bootstrap, never the IIFE body. Torn Bookie's
  // harness documents the failure this avoids: if the whole body is guarded and
  // a test forgets location.search, the script early-returns, the export
  // injection never runs, and the test fails with no usable hint.
  if (isEducationPage()) {
    init();
  }
})();
