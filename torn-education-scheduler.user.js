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
      saveError: state.saveFailed === true,
      selectedCourseId: state.selectedCourseId != null ? state.selectedCourseId : null,
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
      saveError: state.saveFailed === true,
      selectedCourseId: state.selectedCourseId != null ? state.selectedCourseId : null,
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
  function injectStyleOnce(doc) {
    if (doc.querySelector('#tes-style')) return;
    const style = doc.createElement('style');
    style.id = 'tes-style';
    style.textContent = [
      '#tes-panel { border: 1px solid #4a4a4a; background: #1c1c1c; color: #e6e6e6;',
      '  padding: 12px 14px; margin: 12px 0; border-radius: 6px; font-size: 13px; line-height: 1.5; }',
      '#tes-panel .tes-header { font-weight: bold; cursor: pointer; margin-bottom: 8px; }',
      '#tes-panel .tes-finish { font-size: 1.25em; font-weight: bold; color: #7ee081; margin-bottom: 8px; }',
      '#tes-panel .tes-save-error { color: #ff8080; font-weight: bold; margin-bottom: 8px; }',
      '#tes-panel .tes-summary { white-space: pre-line; margin-bottom: 8px; }',
      '#tes-panel .tes-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0; }',
    ].join('\n');
    const parent = doc.head || doc.body;
    if (parent && parent.appendChild) parent.appendChild(style);
  }

  function renderPanel(doc, mount, model, handlers) {
    injectStyleOnce(doc);

    const existing = doc.querySelector('#tes-panel');
    if (existing && existing.remove) existing.remove();

    const panel = doc.createElement('div');
    panel.id = 'tes-panel';
    panel.setAttribute('data-tes-version', SCRIPT_VERSION);

    const header = doc.createElement('div');
    header.className = 'tes-header';
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
        row.className = 'tes-row';
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

  // A fallback error model, shared by buildPanelModel's fetch-failure path
  // and the catch block below, so renderPanel always gets a complete shape.
  function errorModel(message) {
    return {
      status: 'error', message: message, reductionLabel: null,
      queue: [], addable: [], stale: [], problems: [], finishLabel: null, totalLabel: null,
      collapsed: false, saveError: false, selectedCourseId: null,
    };
  }

  const noopHandlers = { onToggle: function () {}, onAdd: function () {}, onRemove: function () {}, onPickerChange: function () {} };

  async function init() {
    const plan = loadPlan();
    // fetchImpl null selects the ambient fetch; cookieString omitted so
    // fetchEducationData reads the ambient cookie jar itself.
    const fetchResult = await fetchEducationData(null);

    // The design requires the panel to be visible even when Torn's markup
    // does not match any known mount selector, rather than rendering
    // nothing with no explanation.
    let mount = findMountPoint(document);
    if (!mount) {
      mount = document.createElement('div');
      mount.id = 'tes-fallback-mount';
      mount.style.position = 'fixed';
      mount.style.bottom = '12px';
      mount.style.right = '12px';
      mount.style.zIndex = '2147483647';
      document.body.appendChild(mount);
    }

    let selectedCourseId = null;

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
          selectedCourseId: selectedCourseId,
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
            commit({ queue: currentPlan.queue.concat([courseId]), collapsed: currentPlan.collapsed });
          },
          onRemove: function (courseId) {
            commit({
              queue: currentPlan.queue.filter(function (id) { return id !== courseId; }),
              collapsed: currentPlan.collapsed,
            });
          },
          onPickerChange: function (value) {
            const parsed = Number(value);
            selectedCourseId = Number.isInteger(parsed) ? parsed : null;
          },
        });
      } catch (e) {
        const detail = (e && e.message) || String(e);
        return renderPanel(document, mount, errorModel(`Education Scheduler hit an error and stopped: ${detail}`), noopHandlers);
      }
    }

    return draw(plan, false);
  }

  // The guard wraps only the bootstrap, never the IIFE body. Torn Bookie's
  // harness documents the failure this avoids: if the whole body is guarded and
  // a test forgets location.search, the script early-returns, the export
  // injection never runs, and the test fails with no usable hint.
  if (isEducationPage()) {
    init();
  }
})();
