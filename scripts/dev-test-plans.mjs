// Local verification harness for lib/secrets.js's plans.json helpers
// (loadPlansRegistry/findPlan/findPlanByStripePriceId) - the real
// multi-tier pricing lookup used by api/onboard_start.js,
// api/github_app_callback.js, api/stripe_webhook.js, and
// scripts/provision-tenant.js. Those files' own dev-test-*.mjs harnesses
// already cover the end-to-end behavior built on top of these functions
// (plan-specific redirects, the UnrecognizedPrice path, --plan auto-fill) -
// this file covers the lookup functions directly and in isolation.
//
// Usage: node scripts/dev-test-plans.mjs

import { findPlan, findPlanByStripePriceId, loadPlansRegistry } from './../lib/secrets.js';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

const PLANS = [
  { planId: 'starter', name: 'Starter', stripePriceId: 'price_starter', stripePaymentLinkUrl: 'https://buy.stripe.com/starter', reviewsPerMonth: 50 },
  { planId: 'standard', name: 'Standard', stripePriceId: 'price_standard', stripePaymentLinkUrl: 'https://buy.stripe.com/standard', reviewsPerMonth: 200 },
  { planId: 'pro', name: 'Pro', stripePriceId: 'price_pro', stripePaymentLinkUrl: 'https://buy.stripe.com/pro', reviewsPerMonth: null }
];

function testFindPlanResolvesByPlanId() {
  console.log('findPlan resolves a known planId to its full plans.json entry');
  const plan = findPlan('standard', PLANS);
  check('found the right entry', !!plan && plan.name === 'Standard' && plan.reviewsPerMonth === 200);
}

function testFindPlanReturnsNullForUnknownPlanId() {
  console.log('findPlan returns null (never throws) for a planId not in the list');
  const plan = findPlan('not-a-real-plan', PLANS);
  check('returns null', plan === null);
}

function testFindPlanHandlesGarbageInputWithoutThrowing() {
  console.log('findPlan never throws on garbage/empty input');
  check('undefined planId', findPlan(undefined, PLANS) === null);
  check('empty plans array', findPlan('standard', []) === null);
  check('a plans array containing a malformed null entry', findPlan('standard', [null, ...PLANS]) !== null);
}

function testFindPlanByStripePriceIdResolvesCorrectly() {
  console.log('findPlanByStripePriceId resolves the plan actually purchased, by Stripe price ID - the real lookup api/stripe_webhook.js depends on to never trust a client-chosen plan');
  const plan = findPlanByStripePriceId('price_pro', PLANS);
  check('found the right entry', !!plan && plan.planId === 'pro');
}

function testFindPlanByStripePriceIdReturnsNullForAnUnrecognizedPrice() {
  console.log('findPlanByStripePriceId returns null - never a default/guessed plan - for a price ID matching nothing in plans.json (this is exactly what makes api/stripe_webhook.js\'s UnrecognizedPrice result possible instead of a silent wrong default)');
  const plan = findPlanByStripePriceId('price_never_configured', PLANS);
  check('returns null, not any plan', plan === null);
}

function testLoadPlansRegistryReadsTheRealCommittedPlansJson() {
  console.log('loadPlansRegistry reads the real, committed plans.json off disk and returns a well-formed array');
  const plans = loadPlansRegistry();
  check('returns an array', Array.isArray(plans));
  check('every entry has the required shape', plans.every((p) => p && typeof p.planId === 'string' && typeof p.name === 'string' && typeof p.stripePriceId === 'string' && typeof p.stripePaymentLinkUrl === 'string'));
  check('planIds are unique (no duplicate tier accidentally committed)', new Set(plans.map((p) => p.planId)).size === plans.length);
}

async function main() {
  testFindPlanResolvesByPlanId();
  testFindPlanReturnsNullForUnknownPlanId();
  testFindPlanHandlesGarbageInputWithoutThrowing();
  testFindPlanByStripePriceIdResolvesCorrectly();
  testFindPlanByStripePriceIdReturnsNullForAnUnrecognizedPrice();
  testLoadPlansRegistryReadsTheRealCommittedPlansJson();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
