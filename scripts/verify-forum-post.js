#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  buildForumPostReport,
  compareRawCatalogue,
  verifyForumPostDraft,
} = require('./forum-post-data');

const root = path.join(__dirname, '..');
const draftPath = path.join(root, 'docs', 'forum-post.md');
const rawPath = path.join(root, 'tests', 'fixtures', 'raw', 'educationInitData.json');
const requireRaw = process.argv.includes('--require-raw');

try {
  const report = buildForumPostReport();
  verifyForumPostDraft(fs.readFileSync(draftPath, 'utf8'), report);

  let rawMessage = 'fresh raw capture: not present (optional for routine checks)';
  if (fs.existsSync(rawPath)) {
    const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    const compared = compareRawCatalogue(raw, report.rawFixture);
    rawMessage = `fresh raw capture: ${compared.categories} categories / ${compared.courses} courses, catalogue unchanged`;
  } else if (requireRaw) {
    throw new Error(`fresh raw capture required but missing at ${rawPath}`);
  }

  console.log('forum post verification passed');
  console.log(`tracked catalogue: ${report.catalogue.categories} categories / ${report.catalogue.courses} courses`);
  console.log(`taxonomy: ${report.taxonomy.health.entries} rows, ${report.taxonomy.health.stale} stale, ${report.taxonomy.health.unmapped} unmapped`);
  for (const [name, route] of Object.entries(report.routes)) {
    console.log(`route ${name}: ${route.days} days / $${route.cost.toLocaleString('en-US')} / ${route.courseIds.length} courses`);
  }
  console.log(`internal payload fact checks: ${report.factChecks.length} courses passed`);
  console.log(rawMessage);
} catch (error) {
  console.error(`forum post verification failed: ${error.message}`);
  process.exitCode = 1;
}
