import os
import sys
import argparse
import json
import base64
from urllib import request, parse, error

# --- CONFIGURATION ---
# Change this to your actual Hub URL or leave it to be prompted
DEFAULT_HUB_URL = "https://your-hub-name.vercel.app"
GITHUB_API_URL = "https://api.github.com"

def _github_api_request(url, token=None):
    """Make a GET request to GitHub API and return JSON data or None on failure."""
    req = request.Request(url)
    if token:
        req.add_header("Authorization", f"token {token}")
    req.add_header("Accept", "application/vnd.github.v3+json")
    try:
        with request.urlopen(req) as response:
            data = response.read()
            return json.loads(data.decode('utf-8'))
    except error.HTTPError as e:
        print(f"Warning: GitHub API request failed: {e.code} {e.reason}")
        return None
    except Exception as e:
        print(f"Warning: GitHub API request error: {e}")
        return None

def _fetch_file_from_repo(owner, repo, path, token=None):
    """Fetch a file from a repository and return its content as string, or None."""
    url = f"{GITHUB_API_URL}/repos/{owner}/{repo}/contents/{parse.quote(path)}"
    data = _github_api_request(url, token)
    if data and data.get('content'):
        # Content is base64 encoded
        try:
            decoded = base64.b64decode(data['content']).decode('utf-8')
            return decoded
        except Exception:
            pass
    return None

def _extract_hub_url_from_workflow(workflow_content):
    """Extract hub URL from a call-hub.yml workflow content."""
    if not workflow_content:
        return None
    import re
    # Look for curl -X POST <url>/api/autonomous_agent
    pattern = r'curl -X POST\s+([^\s]+)/api/autonomous_agent'
    match = re.search(pattern, workflow_content)
    if match:
        return match.group(1).strip()
    return None

def setup_spoke(hub_url=None, source_spoke=None, token=None):
    print("Initializing Spoke Repository...")

    # Determine hub URL: 1) explicit arg, 2) from source spoke, 3) input, 4) default
    if hub_url is None and source_spoke is not None:
        # Try to get hub URL from source spoke's workflow
        if '/' in source_spoke:
            owner, repo = source_spoke.split('/', 1)
            workflow_content = _fetch_file_from_repo(owner, repo, '.github/workflows/call-hub.yml', token)
            if workflow_content:
                extracted_url = _extract_hub_url_from_workflow(workflow_content)
                if extracted_url:
                    hub_url = extracted_url
                    print(f"Using hub URL from source spoke {source_spoke}: {hub_url}")
                else:
                    print(f"Could not extract hub URL from workflow in {source_spoke}")
            else:
                print(f"Could not fetch workflow from {source_spoke}")
        else:
            print(f"Invalid source_spoke format; expected 'owner/repo'")

    if hub_url is None:
        try:
            hub_url = input(f"Enter Hub Vercel URL [{DEFAULT_HUB_URL}]: ") or DEFAULT_HUB_URL
        except EOFError:
            # Handle non-interactive environments
            hub_url = DEFAULT_HUB_URL

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
    parser = argparse.ArgumentParser(description='Set up a spoke repository for the AI CTO Hub.')
    parser.add_argument('--hub-url', help='The Vercel URL of the hub (e.g., https://your-hub-name.vercel.app)')
    parser.add_argument('--source-spoke', help='Owner/Repo of an existing spoke to copy hub URL from (e.g., org/TSO)')
    parser.add_argument('--token', help='GitHub token for accessing source spoke (defaults to GITHUB_TOKEN env var)')
    args = parser.parse_args()
    
    token = args.token or os.environ.get('GITHUB_TOKEN')
    setup_spoke(args.hub_url, args.source_spoke, token)