# Local Lessons Learned

- [Initial Setup]: Hub initialized with basic autonomous agent and workflows.
- [2026-08-05]: Discovered the autonomous agent never fetched real code from spoke repos - it only read lessons.md/NORTH_STAR.md and then asked an LLM to audit "the latest code" with none actually in the prompt. This produced ~2,000 hallucinated GitHub issues in one spoke (tso) over ~4 months. Fixed by fetching the spoke's latest commit diff and including it in the prompt, and by skipping the AI call entirely when there's no usable diff.
- [2026-08-05]: The AI's JSON response was trusted blindly - a parse failure fabricated a synthetic result and posted an issue anyway, and a successful-but-wrong-shaped response got string-interpolated straight into the issue body (producing literal "undefined" / "[object Object]"). Fixed by validating the response shape before ever calling `issues.create`, and skipping (not fabricating) on any failure.
