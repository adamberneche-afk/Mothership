// A minimal GitHub REST client built on a single injected HTTP primitive,
// replacing @octokit/rest - which isn't available in Apps Script's V8
// runtime (no npm, no `import`). Every octokit call this project ever made
// maps 1:1 onto a plain REST endpoint; this file is that mapping, nothing
// more. Every method here is synchronous, matching UrlFetchApp.fetch's own
// real execution model (Apps Script has no event loop for network I/O -
// UrlFetchApp blocks until the response arrives) - the decision logic that
// calls this client is synchronous throughout for the same reason, so
// nothing here needs to return a Promise.
//
// httpFetch signature: (url, { method, headers, payload }) => response
//   where response has getResponseCode(): number and getContentText(): string.
//   This is deliberately UrlFetchApp.fetch's own real return shape - the
//   real Apps Script call site can pass UrlFetchApp.fetch directly with no
//   adapter, and the local dev-test-*.mjs harnesses inject a fake that only
//   needs to satisfy these same two methods.

const GITHUB_API_BASE = 'https://api.github.com';

function buildHeaders(token) {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };
}

function buildQueryString(query) {
  if (!query) return '';
  const params = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return params.length > 0 ? `?${params.join('&')}` : '';
}

// Throws on any non-2xx response, mirroring Octokit's default behavior -
// every call site in the ported decision logic already expects a throw on
// failure (that's what its try/catch blocks are written against).
function request(httpFetch, token, method, path, { query, body } = {}) {
  const url = `${GITHUB_API_BASE}${path}${buildQueryString(query)}`;
  const options = {
    method,
    headers: buildHeaders(token),
    // Apps Script's UrlFetchApp throws on a non-2xx response by default;
    // muteHttpExceptions makes it return the response instead, so this
    // function is the one place that decides what "failure" means, not the
    // platform - consistent behavior whether the real UrlFetchApp or the
    // Node-side test stand-in services the call.
    muteHttpExceptions: true
  };
  if (body !== undefined) options.payload = JSON.stringify(body);

  const response = httpFetch(url, options);
  const status = response.getResponseCode();
  const text = response.getContentText();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null;
    }
  }
  if (status < 200 || status >= 300) {
    const err = new Error(`GitHub API ${method.toUpperCase()} ${path} failed: ${status}`);
    err.status = status;
    err.data = data;
    throw err;
  }
  return { data, status };
}

// httpFetch: the injected HTTP primitive (real: UrlFetchApp.fetch; test: a
// fake with the same two-method response shape). token: GLOBAL_GITHUB_TOKEN.
//
// Deliberately a plain global function, not an ES module export - Apps
// Script has no import/export; every file in a project shares one global
// function scope (script-concatenation semantics, not real modules), so
// this file has to be valid exactly as-is when clasp-pushed unmodified.
// The dev-test harness loads it the same way Apps Script does - see
// scripts/gas-test-harness.mjs.
function makeGithubClient(httpFetch, token) {
  return {
    repos: {
      get: ({ owner, repo }) => request(httpFetch, token, 'get', `/repos/${owner}/${repo}`),

      getContent: ({ owner, repo, path, ref }) =>
        request(httpFetch, token, 'get', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
          query: ref ? { ref } : undefined
        }),

      createOrUpdateFileContents: ({ owner, repo, path, message, content, sha, branch }) =>
        request(httpFetch, token, 'put', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
          body: { message, content, sha, branch }
        }),

      listCommits: ({ owner, repo, per_page }) =>
        request(httpFetch, token, 'get', `/repos/${owner}/${repo}/commits`, { query: { per_page } }),

      getCommit: ({ owner, repo, ref }) =>
        request(httpFetch, token, 'get', `/repos/${owner}/${repo}/commits/${ref}`)
    },
    issues: {
      listForRepo: ({ owner, repo, state, labels, sort, direction, per_page }) =>
        request(httpFetch, token, 'get', `/repos/${owner}/${repo}/issues`, {
          query: { state, labels, sort, direction, per_page }
        }),

      create: ({ owner, repo, title, body, labels }) =>
        request(httpFetch, token, 'post', `/repos/${owner}/${repo}/issues`, { body: { title, body, labels } }),

      update: ({ owner, repo, issue_number, body, state }) =>
        request(httpFetch, token, 'patch', `/repos/${owner}/${repo}/issues/${issue_number}`, {
          body: { body, state }
        })
    },
    // Note the asymmetry, inherited from GitHub's own REST API and from how
    // this codebase already used Octokit: getRef takes a bare ref like
    // "heads/main" and hits the singular /git/ref/{ref} endpoint; createRef
    // takes a fully-qualified "refs/heads/branch-name" and posts to the
    // plural /git/refs collection endpoint.
    git: {
      getRef: ({ owner, repo, ref }) => request(httpFetch, token, 'get', `/repos/${owner}/${repo}/git/ref/${ref}`),

      createRef: ({ owner, repo, ref, sha }) =>
        request(httpFetch, token, 'post', `/repos/${owner}/${repo}/git/refs`, { body: { ref, sha } })
    },
    pulls: {
      create: ({ owner, repo, title, head, base, body }) =>
        request(httpFetch, token, 'post', `/repos/${owner}/${repo}/pulls`, { body: { title, head, base, body } })
    }
  };
}
