# Hub Lessons Learned

- [Initial Setup]: Hub initialized with basic autonomous agent and workflows.
- [Self-Reflection]: Added weekly self-analysis to improve hub code quality.
- [Best Practices]: Keep hub code minimal and focused on orchestration.
- [Workflow Quoting]: Prefer step-outputs over complex inline expressions in workflow `run:` blocks to avoid quoting errors.
- [Node.js Imports]: Always import Node.js core modules (`fs`, `path`) explicitly; don't rely on global availability.
- [CLI Flag Separation]: When wrapping another CLI via `vercel curl`, place tool-specific arguments after a `--` separator.
- [Env Var Verification]: Verify required environment variables at startup; fail fast if any are missing.
- [Defensive Cross-Repo Fetch]: Validate data fetched from another repo; warn on failure and have clear fallback.
- [Deployment Protection]: Remember Vercel deployments may be protected; use bypass tokens or adjust settings for automation.
- [Automated Linting]: Integrate linting for YAML/JavaScript and workflow validation into CI to catch errors early.