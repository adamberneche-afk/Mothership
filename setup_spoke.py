import os

# --- CONFIGURATION ---
# Change this to your actual Hub URL or leave it to be prompted
DEFAULT_HUB_URL = "https://your-hub-name.vercel.app"

def setup_spoke():
    print("Initializing Spoke Repository...")

    hub_url = input(f"Enter Hub Vercel URL [{DEFAULT_HUB_URL}]: ") or DEFAULT_HUB_URL

    files = [
        {
            "path": "NORTH_STAR.md",
            "content": "# Project North Star\n\n## Core Benefit\n[Describe the primary value this specific app provides]\n\n## Emotional Outcome\n[How should the user feel while using this?]"
        },
        {
            "path": "lessons.md",
            "content": "# Local Lessons Learned\n\n- [Date]: Spoke initialized and linked to Hub."
        },
        {
            "path": "ai_decision_log.json",
            "content": "[]"
        },
        {
            "path": ".github/workflows/call-hub.yml",
            "content": f'''name: Ping CTO Hub
on:
  schedule:
    - cron: '*/30 * * * *'
    - cron: '0 0 * * 0'
  workflow_dispatch:

jobs:
  call-central-brain:
    runs-on: ubuntu-latest
    steps:
      - name: Send Payload to Hub
        run: |
          curl -X POST {hub_url}/api/autonomous_agent \\
          -H "Content-Type: application/json" \\
          -d '{{
            "owner": "${{{{ github.repository_owner }}}}",
            "repo": "${{{{ github.event.repository.name }}}}",
            "mode": "${{{{ github.event.schedule == '\\''0 0 * * 0'\\'' && '\\''refactor'\\'' || '\\''debug'\\'' }}}}"
          }}' '''
        }
    ]

    for f in files:
        os.makedirs(os.path.dirname(f["path"]), exist_ok=True) if os.path.dirname(f["path"]) else None
        with open(f["path"], "w") as file:
            file.write(f["content"])
        print(f"Created: {f['path']}")

    print("\n" + "="*50)
    print("SPOKE HANDSHAKE COMPLETE")
    print("="*50)
    print("FINAL STEPS:")
    print("1. Commit and push these files to your GitHub repository.")
    print("2. In GitHub, go to Settings > Secrets and variables > Actions.")
    print(f"3. Ensure your Hub's GLOBAL_GITHUB_TOKEN has access to this repo.")
    print("4. Trigger the 'Ping CTO Hub' workflow manually to test the link.")
    print("="*50)

if __name__ == "__main__":
    setup_spoke()