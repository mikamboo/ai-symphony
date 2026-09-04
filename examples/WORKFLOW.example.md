---
# Copy this file to WORKFLOW.md in whatever directory you'll run `symphony`/`pnpm run dev` from,
# fill in team_key (and project_id if you want one), and set LINEAR_API_KEY before starting.
# Full field reference: docs/workflow-config.md. This file's design is explained in
# examples/README.md under "WORKFLOW.example.md".

agent_runner:
  kind: claude_code

tracker:
  kind: linear
  provider:
    api_key: $LINEAR_API_KEY
    team_key: SMA
  # Gates dispatch AND is removed by the after_run hook below once this issue has been
  # commented on, so the same issue is never picked up twice. Don't drop this label from an
  # issue's required set without replacing it with some other way to stop re-dispatch.
  required_labels: [symphony]
  active_states: [Todo, "In Progress"]
  terminal_states: [Done, Canceled, Duplicate]

polling:
  interval_ms: 30000

workspace:
  root: ./symphony_workspaces

hooks:
  after_create: |
    echo "Workspace ready for $(basename "$PWD")"
    # Optional: check out the real repository this issue is about, so the agent has actual code
    # to read. Not required for this workflow (the agent only investigates, never edits), but
    # makes its investigation and report meaningfully better than reading the issue text alone.
    # git clone --depth 1 git@github.com:your-org/your-repo.git .

  # Posts exactly one Linear comment proving the pipeline ran, then removes the trigger label so
  # this issue is never dispatched again. Runs host-side with Symphony's own LINEAR_API_KEY --
  # the coding-agent process never receives that credential (SPEC.md 15.3; ClaudeCodeAgentRunner
  # strips it). Needs python3 on the machine running Symphony; no other dependency.
  after_run: |
    python3 - <<'PYEOF'
    import json
    import os
    import urllib.request

    api_key = os.environ.get("LINEAR_API_KEY")
    if not api_key:
        print("Symphony smoke-test hook: LINEAR_API_KEY not set, skipping")
        raise SystemExit(0)

    identifier = os.path.basename(os.getcwd())
    marker = "Symphony smoke test"
    trigger_label = "symphony"
    endpoint = "https://api.linear.app/graphql"

    def gql(query, variables):
        body = json.dumps({"query": query, "variables": variables}).encode("utf-8")
        req = urllib.request.Request(
            endpoint, data=body, headers={"Content-Type": "application/json", "Authorization": api_key}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.load(resp)

    resolved = gql(
        """
        query($id: String!) {
          issue(id: $id) {
            id
            comments(first: 50) { nodes { body } }
            labels(first: 50) { nodes { id name } }
          }
        }
        """,
        {"id": identifier},
    )
    issue = (resolved.get("data") or {}).get("issue")
    if not issue:
        print(f"Symphony smoke-test hook: could not resolve Linear issue '{identifier}', skipping")
        raise SystemExit(0)

    comments = (issue.get("comments") or {}).get("nodes") or []
    already_commented = any(marker in (c.get("body") or "") for c in comments)

    if not already_commented:
        body_text = (
            f"{marker}: Symphony polled this issue, dispatched a workspace, and ran a "
            "ClaudeCodeAgentRunner turn successfully. No code changes were made by design "
            "(see WORKFLOW.example.md) -- this comment is proof the poll, dispatch, agent turn, "
            "and report steps all worked end to end. The 'symphony' label is being removed so "
            "this issue is not dispatched again."
        )
        result = gql(
            "mutation($issueId: String!, $body: String!) { commentCreate(input: {issueId: $issueId, body: $body}) { success } }",
            {"issueId": issue["id"], "body": body_text},
        )
        success = ((result.get("data") or {}).get("commentCreate") or {}).get("success")
        print(f"Symphony smoke-test hook: comment posted={bool(success)} on {identifier}")
    else:
        print(f"Symphony smoke-test hook: {identifier} already has the marker comment")

    labels = (issue.get("labels") or {}).get("nodes") or []
    label_id = next((l["id"] for l in labels if l.get("name", "").lower() == trigger_label), None)
    if label_id:
        gql(
            "mutation($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }",
            {"id": issue["id"], "labelId": label_id},
        )
        print(f"Symphony smoke-test hook: removed '{trigger_label}' label from {identifier}")
    else:
        print(f"Symphony smoke-test hook: no '{trigger_label}' label found on {identifier} to remove")
    PYEOF

  timeout_ms: 60000

agent:
  max_concurrent_agents: 1
  max_turns: 1

codex:
  command: "claude"
  turn_timeout_ms: 600000
---

You are doing a one-time smoke test of an automated pipeline, not fixing this issue.

Issue: {{ issue.identifier }} - {{ issue.title }}
URL: {{ issue.url }}
{% if issue.description %}
Description:
{{ issue.description }}
{% endif %}

Read the issue (and the repository, if one is checked out in this workspace) and write a short
plain-text summary: what the issue is asking for, and, if you looked at the code, roughly what a
real fix would involve.

Do not create, edit, or delete any files. Do not run commands that change anything (no commits, no
package installs, no writes of any kind) -- read-only tools only, even though nothing in this
workspace technically stops you from using your file-editing tools. Do not attempt to comment on
or otherwise modify the Linear issue yourself; posting the confirmation comment is handled outside
this session on purpose (see WORKFLOW.example.md), specifically so this agent session never needs
your Linear credential at all.

End your response with your summary. There is nothing else to do after that.
