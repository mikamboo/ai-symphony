#!/usr/bin/env python3
"""Shared `hooks.after_run` script for the PM/Architect/Dev/QA pipeline.

Design: ../../docs/dev-workflow-pipeline.md. One copy of this file is invoked identically by all
four WORKFLOW.md's `hooks.after_run`, parameterized entirely through environment variables set in
each WORKFLOW.md's own hook block (`SYMPHONY_STAGE`, `SYMPHONY_NEXT_STATE`, ...). It never touches
the coding agent's process -- it runs host-side, after the turn, using credentials the agent never
receives (SPEC.md 15.3), the same isolation pattern as `examples/WORKFLOW.example.md`.

Why this exists at all: Symphony calls `hooks.after_run` unconditionally after every attempt --
success, failure, or timeout -- and passes it no signal about what happened
(`src/workspace/manager.ts: runAfterRun`, `src/orchestrator/orchestrator.ts`). The only way this
script can know what the agent concluded is by reading a file the agent itself wrote as its last
action: `.symphony/decision_<stage>.json`. Each stage's WORKFLOW.md prompt instructs the agent to
write it in this shape:

    {"status": "done" | "blocked", "summary": "...", ...stage-specific extra fields}

  - status "blocked": the agent didn't finish. The issue is left in its current Linear state and
    commented; Symphony's own retry/continuation behavior (SPEC.md 7.1) re-polls it -- no
    pipeline-specific "retry" logic lives here, see docs/dev-workflow-pipeline.md "Retry vs.
    bounce".
  - status "done": stage-specific handling below (PM/Architect/Dev advance one state; QA either
    advances to Done or bounces back to Development, capped).

If no decision file exists for this stage on a given `after_run` invocation (e.g. the agent made
no progress and wrote nothing), this script does nothing beyond logging -- it never comments or
moves state on a guess.

Verification status (see docs/adapters/linear.md "Real integration profile" for why this matters):
all Linear GraphQL shapes used below (`issueUpdate`, `workflowStates`, `issueCreate`, plus the
already-shipped `issue`/`commentCreate`/`issueRemoveLabel` from examples/WORKFLOW.example.md) were
checked against Linear's live schema via unauthenticated introspection before being written here.
The GitHub REST calls (`open_pr`/`review_pr`/`merge_pr`) were NOT independently live-verified --
this sandbox's outbound access doesn't reach api.github.com for a real repo -- they follow GitHub's
long-stable, well-documented REST shapes but should be smoke-tested against a real token/repo
before trusting this in production, same as any other unverified integration in this repo.
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

LINEAR_ENDPOINT = "https://api.linear.app/graphql"
GITHUB_API = "https://api.github.com"

DECISION_DIR = ".symphony"
PIPELINE_STATE_PATH = os.path.join(DECISION_DIR, "pipeline_state.json")


def env(name, default=None, required=False):
    value = os.environ.get(name, default)
    if required and not value:
        raise RuntimeError(f"missing required env {name}")
    return value


# --- Linear -----------------------------------------------------------------------------------

def gql(api_key, query, variables):
    body = json.dumps({"query": query, "variables": variables}).encode("utf-8")
    req = urllib.request.Request(
        LINEAR_ENDPOINT, data=body, headers={"Content-Type": "application/json", "Authorization": api_key}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.load(resp)
    if data.get("errors"):
        raise RuntimeError(f"Linear GraphQL errors: {data['errors']}")
    return data["data"]


def resolve_issue(api_key, identifier):
    data = gql(
        api_key,
        """
        query($id: String!) {
          issue(id: $id) {
            id
            title
            team { id key }
            state { id name }
          }
        }
        """,
        {"id": identifier},
    )
    return data.get("issue")


def resolve_state_id(api_key, team_id, name):
    data = gql(
        api_key,
        """
        query($teamId: ID, $name: String!) {
          workflowStates(filter: { team: { id: { eq: $teamId } }, name: { eqIgnoreCase: $name } }, first: 1) {
            nodes { id name }
          }
        }
        """,
        {"teamId": team_id, "name": name},
    )
    nodes = data["workflowStates"]["nodes"]
    if not nodes:
        raise RuntimeError(
            f"no workflow state named '{name}' on this team -- create it in Linear team settings first"
        )
    return nodes[0]["id"]


def move_state(api_key, issue_id, state_id):
    gql(
        api_key,
        """
        mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success }
        }
        """,
        {"id": issue_id, "input": {"stateId": state_id}},
    )


def comment(api_key, issue_id, body):
    gql(
        api_key,
        """
        mutation($issueId: String!, $body: String!) {
          commentCreate(input: {issueId: $issueId, body: $body}) { success }
        }
        """,
        {"issueId": issue_id, "body": body},
    )


def create_subissue(api_key, team_id, parent_id, title, description):
    gql(
        api_key,
        """
        mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) { success }
        }
        """,
        {"input": {"teamId": team_id, "parentId": parent_id, "title": title, "description": description}},
    )


# --- GitHub (dev/qa only) ----------------------------------------------------------------------

def gh(token, method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        f"{GITHUB_API}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as cause:
        raise RuntimeError(f"GitHub API {method} {path} failed: {cause.code} {cause.read().decode()[:500]}")


def run_git(args):
    subprocess.run(["git", *args], check=True)


def open_pr(identifier, title, body):
    token = env("GITHUB_TOKEN", required=True)
    repo = env("GITHUB_REPO", required=True)  # "owner/repo"
    base = env("GITHUB_BASE_BRANCH", "main")
    branch = f"symphony/{identifier.lower()}"

    run_git(["checkout", "-b", branch])
    run_git(["add", "-A"])
    if subprocess.run(["git", "diff", "--cached", "--quiet"]).returncode == 0:
        return None  # nothing to commit -- not an error, just nothing to PR

    run_git(["commit", "-m", title])
    run_git(["push", "-u", "origin", branch])
    pr = gh(token, "POST", f"/repos/{repo}/pulls", {"title": title, "head": branch, "base": base, "body": body})
    return {"number": pr["number"], "url": pr["html_url"], "branch": branch}


def review_pr(pr_number, event, body):
    token = env("GITHUB_TOKEN", required=True)
    repo = env("GITHUB_REPO", required=True)
    gh(token, "POST", f"/repos/{repo}/pulls/{pr_number}/reviews", {"event": event, "body": body})


def merge_pr(pr_number):
    token = env("GITHUB_TOKEN", required=True)
    repo = env("GITHUB_REPO", required=True)
    gh(token, "PUT", f"/repos/{repo}/pulls/{pr_number}/merge", {"merge_method": "squash"})


# --- local files (handoff + bounce counter) ---------------------------------------------------

def load_decision(stage):
    path = os.path.join(DECISION_DIR, f"decision_{stage}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        decision = json.load(f)
    os.remove(path)  # consume -- never reprocess a stale decision on a later poll
    return decision


def load_pipeline_state():
    if os.path.exists(PIPELINE_STATE_PATH):
        with open(PIPELINE_STATE_PATH) as f:
            return json.load(f)
    return {}


def save_pipeline_state(state):
    os.makedirs(DECISION_DIR, exist_ok=True)
    with open(PIPELINE_STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


# --- main --------------------------------------------------------------------------------------

def main():
    api_key = os.environ.get("LINEAR_API_KEY")
    if not api_key:
        print("symphony_stage_hook: LINEAR_API_KEY not set, skipping")
        return

    stage = env("SYMPHONY_STAGE", required=True)
    identifier = os.path.basename(os.getcwd())

    issue = resolve_issue(api_key, identifier)
    if not issue:
        print(f"symphony_stage_hook[{stage}]: could not resolve Linear issue '{identifier}', skipping")
        return

    decision = load_decision(stage)
    if decision is None:
        print(f"symphony_stage_hook[{stage}]: no decision file this turn, nothing to do")
        return

    status = decision.get("status")
    summary = decision.get("summary", "(no summary provided)")
    team_id = issue["team"]["id"]

    if status == "blocked":
        comment(api_key, issue["id"], f"[{stage}] blocked: {summary}")
        print(f"symphony_stage_hook[{stage}]: blocked, left in {issue['state']['name']}")
        return

    if status != "done":
        print(f"symphony_stage_hook[{stage}]: unrecognized decision status {status!r}, ignoring")
        return

    if stage == "pm":
        next_state = env("SYMPHONY_NEXT_STATE", required=True)  # "Design"
        for sub in decision.get("subtasks", []):
            create_subissue(api_key, team_id, issue["id"], sub["title"], sub.get("description", ""))
        comment(api_key, issue["id"], f"[pm] {summary}")
        move_state(api_key, issue["id"], resolve_state_id(api_key, team_id, next_state))
        print(f"symphony_stage_hook[pm]: created {len(decision.get('subtasks', []))} sub-issue(s), moved {identifier} to {next_state}")
        return

    if stage == "architect":
        next_state = env("SYMPHONY_NEXT_STATE", required=True)  # "Development"
        comment(api_key, issue["id"], f"[architect] {summary}")
        move_state(api_key, issue["id"], resolve_state_id(api_key, team_id, next_state))
        print(f"symphony_stage_hook[architect]: moved {identifier} to {next_state}")
        return

    if stage == "dev":
        next_state = env("SYMPHONY_NEXT_STATE", required=True)  # "Review"
        pipeline_state = load_pipeline_state()
        pr = open_pr(identifier, f"{identifier}: {issue.get('title', summary)[:60]}", f"Closes {identifier}.\n\n{summary}")
        if pr is None:
            comment(api_key, issue["id"], f"[dev] {summary}\n\n(no file changes to commit this turn)")
            print(f"symphony_stage_hook[dev]: nothing to commit for {identifier}, state unchanged")
            return
        pipeline_state.update(pr)
        save_pipeline_state(pipeline_state)
        comment(api_key, issue["id"], f"[dev] {summary}\n\nPR: {pr['url']}")
        move_state(api_key, issue["id"], resolve_state_id(api_key, team_id, next_state))
        print(f"symphony_stage_hook[dev]: opened {pr['url']}, moved {identifier} to {next_state}")
        return

    if stage == "qa":
        result = decision.get("result")
        pipeline_state = load_pipeline_state()
        pr_number = pipeline_state.get("number")
        if not pr_number:
            comment(api_key, issue["id"], f"[qa] {summary}\n\n(no PR on record for this issue -- skipping GitHub review)")
            print(f"symphony_stage_hook[qa]: no PR number recorded for {identifier}")
            return

        if result == "pass":
            done_state = env("SYMPHONY_NEXT_STATE", required=True)  # "Done"
            review_pr(pr_number, "APPROVE", summary)
            merge_pr(pr_number)
            comment(api_key, issue["id"], f"[qa] passed: {summary}")
            move_state(api_key, issue["id"], resolve_state_id(api_key, team_id, done_state))
            print(f"symphony_stage_hook[qa]: approved+merged PR #{pr_number}, moved {identifier} to {done_state}")
            return

        if result == "fail":
            fail_state = env("SYMPHONY_FAIL_STATE", required=True)  # "Development"
            blocked_state = env("SYMPHONY_BOUNCE_LIMIT_STATE", "Blocked")
            cap = int(env("SYMPHONY_BOUNCE_CAP", "3"))
            bounce_count = pipeline_state.get("qa_bounce_count", 0) + 1
            pipeline_state["qa_bounce_count"] = bounce_count
            save_pipeline_state(pipeline_state)
            review_pr(pr_number, "REQUEST_CHANGES", summary)

            if bounce_count > cap:
                comment(
                    api_key,
                    issue["id"],
                    f"[qa] failed ({bounce_count} attempts, cap {cap}): {summary}\n\nMoving to {blocked_state} for a human.",
                )
                move_state(api_key, issue["id"], resolve_state_id(api_key, team_id, blocked_state))
                print(f"symphony_stage_hook[qa]: bounce cap exceeded, moved {identifier} to {blocked_state}")
            else:
                comment(api_key, issue["id"], f"[qa] failed (attempt {bounce_count}/{cap}): {summary}")
                move_state(api_key, issue["id"], resolve_state_id(api_key, team_id, fail_state))
                print(f"symphony_stage_hook[qa]: requested changes, bounced {identifier} back to {fail_state}")
            return

        print(f"symphony_stage_hook[qa]: unrecognized result {result!r}, ignoring")
        return

    print(f"symphony_stage_hook: unrecognized stage {stage!r}")


if __name__ == "__main__":
    try:
        main()
    except Exception as cause:
        # after_run is best-effort at the Symphony level (failure is logged and ignored -- SPEC.md
        # 9.4), but a non-zero exit here still gets surfaced as `hook.failed` in Symphony's own
        # structured logs, which is what we want instead of a silently swallowed stack trace.
        print(f"symphony_stage_hook: error -- {cause}", file=sys.stderr)
        raise
