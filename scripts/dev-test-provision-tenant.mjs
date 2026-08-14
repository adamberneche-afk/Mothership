// Local verification harness for scripts/provision-tenant.js. The core
// functions (validateTenantInput/provisionTenant) never touch fs - all
// registry state is passed in and returned, so these tests need no
// scratch directory or real file I/O at all.
//
// Usage: node scripts/dev-test-provision-tenant.mjs

import { validateTenantInput, provisionTenant } from './provision-tenant.js';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

function baseInput(overrides = {}) {
  return {
    tenantId: 'acme',
    name: 'Acme Corp',
    plan: 'pro',
    credentialRef: 'env:ACME_GITHUB_TOKEN',
    spokes: [],
    now: 1_700_000_000_000,
    ...overrides
  };
}

// --- Tests -------------------------------------------------------------------

function testHappyPathWithEnvRef() {
  console.log('a well-formed tenant with an env: credential ref is accepted');
  const result = provisionTenant(baseInput());
  check('provisioned', result.status === 'Provisioned');
  check('the tenant record is correct', result.tenant.tenantId === 'acme' && result.tenant.githubCredentialRef === 'env:ACME_GITHUB_TOKEN' && result.tenant.status === 'active');
  check('tenantsJson includes the new tenant', result.tenantsJson.some((t) => t.tenantId === 'acme'));
}

function testHappyPathWithGhappRef() {
  console.log('a well-formed tenant with a ghapp: credential ref is accepted');
  const result = provisionTenant(baseInput({ tenantId: 'globex', credentialRef: 'ghapp:123456' }));
  check('provisioned', result.status === 'Provisioned');
  check('the credential ref is preserved exactly', result.tenant.githubCredentialRef === 'ghapp:123456');
}

function testDuplicateTenantIdRejectedCaseInsensitive() {
  console.log('a duplicate tenantId is hard-rejected, including a case-insensitive match (Acme vs acme)');
  const existingTenants = [{ tenantId: 'Acme', name: 'Existing', status: 'active', plan: 'pro', quota: { reviewsPerMonth: null }, githubCredentialRef: 'env:X', createdAt: '2026-01-01T00:00:00Z' }];
  const result = provisionTenant(baseInput({ tenantId: 'acme' }), { existingTenants });
  check('rejected', result.status === 'Invalid');
  check('the error names the case-insensitive collision', result.errors.some((e) => /already exists/.test(e)));
}

function testBadTenantIdShapeRejected() {
  console.log('a tenantId with an invalid shape is rejected');
  const result = provisionTenant(baseInput({ tenantId: 'Not_Valid!' }));
  check('rejected', result.status === 'Invalid');
  check('the error names the tenant-id field', result.errors.some((e) => /tenant-id must match/.test(e)));
}

function testKvSchemeHardRejected() {
  console.log('credential-ref=kv:... is hard-rejected with an explicit not-implemented error');
  const result = provisionTenant(baseInput({ credentialRef: 'kv:tenant/acme/token' }));
  check('rejected', result.status === 'Invalid');
  check('the error explicitly says kv: is not implemented', result.errors.some((e) => /kv: scheme is not implemented/.test(e)));
}

function testUnknownSchemeRejected() {
  console.log('a credential-ref with no recognized scheme is rejected');
  const result = provisionTenant(baseInput({ credentialRef: 'weird:whatever' }));
  check('rejected', result.status === 'Invalid');
}

function testRawTokenShapedEnvValueRejected() {
  console.log('credential-ref=env:<value that looks like a pasted raw token> is hard-rejected (the operator-mistake guard)');
  const result = provisionTenant(baseInput({ credentialRef: 'env:ghp_1234567890abcdefghijklmnopqrstuvwxyz' }));
  check('rejected', result.status === 'Invalid');
  check('the error explains the raw-token-shape concern', result.errors.some((e) => /raw token/.test(e)));
}

function testOverlongEnvVarNameRejected() {
  console.log('credential-ref=env:<suspiciously long value> is rejected even without a known token prefix');
  const longValue = 'A'.repeat(100);
  const result = provisionTenant(baseInput({ credentialRef: `env:${longValue}` }));
  check('rejected', result.status === 'Invalid');
}

function testLowercaseEnvVarNameRejected() {
  console.log("credential-ref=env:lowercase_name is rejected (doesn't look like a real env var name)");
  const result = provisionTenant(baseInput({ credentialRef: 'env:not_a_real_var_name' }));
  check('rejected', result.status === 'Invalid');
}

function testMalformedGhappIdRejected() {
  console.log('credential-ref=ghapp:abc (non-numeric) and ghapp:0 (out of range) are both rejected');
  const nonNumeric = provisionTenant(baseInput({ credentialRef: 'ghapp:abc' }));
  const zero = provisionTenant(baseInput({ credentialRef: 'ghapp:0' }));
  check('non-numeric rejected', nonNumeric.status === 'Invalid');
  check('zero rejected', zero.status === 'Invalid');
}

function testGhappIdAlreadyUsedByAnotherTenantRejected() {
  console.log('a ghapp:<id> already used by another tenant is rejected (one-installation-one-tenant invariant)');
  const existingTenants = [{ tenantId: 'other-tenant', name: 'Other', status: 'active', plan: 'pro', quota: { reviewsPerMonth: null }, githubCredentialRef: 'ghapp:999', installationId: 999, createdAt: '2026-01-01T00:00:00Z' }];
  const result = provisionTenant(baseInput({ tenantId: 'newcomer', credentialRef: 'ghapp:999' }), { existingTenants });
  check('rejected', result.status === 'Invalid');
  check('the error names the conflicting tenant', result.errors.some((e) => /already used by tenant 'other-tenant'/.test(e)));
}

function testMissingRequiredFieldsRejected() {
  console.log('missing name/plan are rejected with specific errors');
  const result = provisionTenant(baseInput({ name: '', plan: '' }));
  check('rejected', result.status === 'Invalid');
  check('name error present', result.errors.some((e) => /name is required/.test(e)));
  check('plan error present', result.errors.some((e) => /plan is required/.test(e)));
}

function testNameWithNewlineOrBacktickRejected() {
  console.log('a name containing a newline or backtick is rejected (PR-body injection guard, since tenant.name is embedded raw into a hub PR body)');
  const withNewline = provisionTenant(baseInput({ name: 'Acme\nCorp' }));
  const withBacktick = provisionTenant(baseInput({ name: 'Acme `rm -rf /` Corp' }));
  check('newline rejected', withNewline.status === 'Invalid');
  check('backtick rejected', withBacktick.status === 'Invalid');
}

function testInvalidQuotaValuesRejected() {
  console.log('quota of 0, negative, non-integer, and garbage are all rejected');
  check('0 rejected', provisionTenant(baseInput({ quota: '0' })).status === 'Invalid');
  check('negative rejected', provisionTenant(baseInput({ quota: '-5' })).status === 'Invalid');
  check('non-integer rejected', provisionTenant(baseInput({ quota: '1.5' })).status === 'Invalid');
  check('garbage rejected', provisionTenant(baseInput({ quota: 'not-a-number' })).status === 'Invalid');
}

function testOmittedQuotaMeansUnlimited() {
  console.log('an omitted quota results in reviewsPerMonth: null (unlimited), not a validation error');
  const result = provisionTenant(baseInput());
  check('provisioned', result.status === 'Provisioned');
  check('quota is null (unlimited)', result.tenant.quota.reviewsPerMonth === null);
}

function testInvalidStatusRejected() {
  console.log('an arbitrary free-text status is rejected - only active/suspended are allowed');
  const result = provisionTenant(baseInput({ status: 'definitely-not-a-real-status' }));
  check('rejected', result.status === 'Invalid');
}

function testSpokeWrongShapeRejected() {
  console.log('a --spoke value not in owner/repo form is rejected');
  const result = provisionTenant(baseInput({ spokes: ['not-owner-slash-repo'] }));
  check('rejected', result.status === 'Invalid');
}

function testSpokeAlreadyBelongingToAnotherTenantRejected() {
  console.log('a --spoke already registered to a DIFFERENT tenant is rejected');
  const existingSpokes = [{ tenantId: 'someone-else', owner: 'acme-org', repo: 'widget', addedAt: '2026-01-01T00:00:00Z', status: 'active' }];
  const result = provisionTenant(baseInput({ spokes: ['acme-org/widget'] }), { existingSpokes });
  check('rejected', result.status === 'Invalid');
  check('the error names the conflicting tenant', result.errors.some((e) => /already registered to a different tenant \('someone-else'\)/.test(e)));
}

function testInitialSpokesAppendedCorrectly() {
  console.log('valid --spoke arguments are appended to spokesJson, attributed to the new tenant');
  const result = provisionTenant(baseInput({ spokes: ['acme-org/widget', 'acme-org/gadget'] }));
  check('provisioned', result.status === 'Provisioned');
  check('both spokes appear in spokesJson', result.spokesJson.some(s => s.owner === 'acme-org' && s.repo === 'widget') && result.spokesJson.some(s => s.owner === 'acme-org' && s.repo === 'gadget'));
  check('both are attributed to the new tenant', result.spokesJson.every(s => s.tenantId === 'acme'));
}

function testSpokeAlreadyBelongingToTheSameTenantIsANoOpNotAnError() {
  console.log('a --spoke already registered to THIS SAME tenant is silently skipped, not duplicated or rejected');
  const existingSpokes = [{ tenantId: 'acme', owner: 'acme-org', repo: 'widget', addedAt: '2026-01-01T00:00:00Z', status: 'active' }];
  const result = provisionTenant(baseInput({ spokes: ['acme-org/widget'] }), { existingSpokes });
  check('provisioned (not an error)', result.status === 'Provisioned');
  check('the spoke was not duplicated', result.spokesJson.filter(s => s.owner === 'acme-org' && s.repo === 'widget').length === 1);
}

function testDryRunTouchesNoRegistryState() {
  console.log('--dry-run returns the would-write data without mutating or returning tenantsJson/spokesJson');
  const result = provisionTenant(baseInput({ dryRun: true, spokes: ['acme-org/widget'] }));
  check('status is DryRun', result.status === 'DryRun');
  check('the would-be tenant is shown', result.tenant.tenantId === 'acme');
  check('the would-be spoke is shown', result.spokesToAdd.length === 1);
  check('no tenantsJson/spokesJson is computed for a dry run', result.tenantsJson === undefined && result.spokesJson === undefined);
}

function testCredentialRefRequired() {
  console.log('a missing credential-ref is rejected, not silently defaulted');
  const result = provisionTenant(baseInput({ credentialRef: undefined }));
  check('rejected', result.status === 'Invalid');
  check('the error names the credential-ref field', result.errors.some((e) => /credential-ref is required/.test(e)));
}

async function main() {
  testHappyPathWithEnvRef();
  testHappyPathWithGhappRef();
  testDuplicateTenantIdRejectedCaseInsensitive();
  testBadTenantIdShapeRejected();
  testKvSchemeHardRejected();
  testUnknownSchemeRejected();
  testRawTokenShapedEnvValueRejected();
  testOverlongEnvVarNameRejected();
  testLowercaseEnvVarNameRejected();
  testMalformedGhappIdRejected();
  testGhappIdAlreadyUsedByAnotherTenantRejected();
  testMissingRequiredFieldsRejected();
  testNameWithNewlineOrBacktickRejected();
  testInvalidQuotaValuesRejected();
  testOmittedQuotaMeansUnlimited();
  testInvalidStatusRejected();
  testSpokeWrongShapeRejected();
  testSpokeAlreadyBelongingToAnotherTenantRejected();
  testInitialSpokesAppendedCorrectly();
  testSpokeAlreadyBelongingToTheSameTenantIsANoOpNotAnError();
  testDryRunTouchesNoRegistryState();
  testCredentialRefRequired();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
