// Shared read-modify-write-with-retry helper for appending to a hub-root
// JSON array file (tenants.json, spokes.json) via the GitHub Contents API.
// Generalizes the retry-on-conflict pattern scripts/prune-logs.js already
// uses for ai_decision_log.json - factored out here because
// api/stripe_webhook.js's tenant-provisioning write needs the exact same
// shape, and a third real caller is a good point to share it rather than
// hand-copy it again.

export async function readJsonArrayFile(octokit, owner, repo, path) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { entries: Array.isArray(parsed) ? parsed : [], sha: data.sha };
  } catch (e) {
    return { entries: [], sha: null };
  }
}

export async function writeJsonArrayFile(octokit, owner, repo, path, entries, sha, message) {
  const content = Buffer.from(JSON.stringify(entries, null, 2)).toString('base64');
  const params = { owner, repo, path, message, content };
  if (sha) params.sha = sha;
  await octokit.repos.createOrUpdateFileContents(params);
}

// Appends one entry to a hub-root JSON registry, re-reading fresh on every
// retry attempt so a conflict discovered mid-retry (e.g. a DIFFERENT
// writer already added the exact entry this call was about to add) is
// detected as "already present -> skip", not blindly retried into a
// duplicate. `decide(freshEntries)` is called against the just-read data
// on every attempt and must return either:
//   { skip: true, result }             - don't write anything, return `result` as-is
//   { skip: false, entry, result }     - append `entry`, then return `result`
// This is what makes a call like "provision a tenant for this
// installation id" safe to run twice (a genuine Stripe webhook retry, or
// two near-simultaneous deliveries racing each other) - whichever call
// loses the race sees the winner's entry on its next re-read and skips,
// rather than creating a duplicate or clobbering the file with a stale sha.
export async function appendToJsonRegistryWithRetry(octokit, owner, repo, path, { decide, message, maxAttempts = 3 }) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { entries, sha } = await readJsonArrayFile(octokit, owner, repo, path);
    const decision = decide(entries);
    if (decision.skip) return decision.result;
    try {
      await writeJsonArrayFile(octokit, owner, repo, path, [...entries, decision.entry], sha, message);
      return decision.result;
    } catch (e) {
      lastError = e;
      // Most likely a stale-sha conflict from a concurrent writer - loop
      // and re-read from scratch, which will see that writer's change and
      // re-run `decide` against it.
    }
  }
  throw lastError;
}

// Updates one existing entry in a hub-root JSON registry (e.g. flipping a
// tenant's status), same retry-on-conflict shape as
// appendToJsonRegistryWithRetry. `find(freshEntries)` returns the index to
// update, or -1 if no matching entry exists (returns `{found: false}`
// without writing). `update(existingEntry)` returns the replacement entry,
// or `null` to mean "found it, but nothing needs to change" (returns
// `{found: true, changed: false, entry: existingEntry}` without writing -
// e.g. an unsuspend webhook arriving for a tenant that isn't suspended for
// the reason this webhook is allowed to undo).
export async function updateJsonRegistryEntryWithRetry(octokit, owner, repo, path, { find, update, message, maxAttempts = 3 }) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { entries, sha } = await readJsonArrayFile(octokit, owner, repo, path);
    const index = find(entries);
    if (index === -1) return { found: false };
    const updatedEntry = update(entries[index]);
    if (updatedEntry === null) return { found: true, changed: false, entry: entries[index] };
    const newEntries = entries.slice();
    newEntries[index] = updatedEntry;
    try {
      await writeJsonArrayFile(octokit, owner, repo, path, newEntries, sha, message);
      return { found: true, changed: true, entry: updatedEntry };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
