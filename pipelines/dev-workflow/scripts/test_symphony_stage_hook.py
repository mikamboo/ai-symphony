#!/usr/bin/env python3
"""Unit tests for symphony_stage_hook.py's control flow (decision -> Linear/GitHub calls).

Network functions (gql/gh/git) are monkeypatched at the module's higher-level wrappers
(resolve_issue, move_state, open_pr, ...) so these tests exercise the actual branching logic in
main() -- the part hand-written for this pipeline -- without hitting real APIs. The GraphQL/REST
*shapes* those wrappers build are covered separately: see the module docstring's "Verification
status" section for what was checked against Linear's live schema via introspection.

Run: python3 pipelines/dev-workflow/scripts/test_symphony_stage_hook.py
"""

import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import symphony_stage_hook as hook


FAKE_ISSUE = {
    "id": "issue-uuid-1",
    "title": "Do the thing",
    "team": {"id": "team-uuid-1", "key": "SMA"},
    "state": {"id": "state-uuid-backlog", "name": "Backlog"},
}


class StageHookTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        os.makedirs(hook.DECISION_DIR, exist_ok=True)

        self.env_patch = mock.patch.dict(
            os.environ,
            {"LINEAR_API_KEY": "fake-key", "GITHUB_TOKEN": "fake-token", "GITHUB_REPO": "org/repo"},
            clear=False,
        )
        self.env_patch.start()

        self.resolve_issue = self._patch("resolve_issue", return_value=dict(FAKE_ISSUE))
        self.resolve_state_id = self._patch("resolve_state_id", side_effect=lambda api_key, team_id, name: f"state-{name}")
        self.move_state = self._patch("move_state")
        self.comment = self._patch("comment")
        self.create_subissue = self._patch("create_subissue")
        self.open_pr = self._patch("open_pr", return_value={"number": 42, "url": "https://github.com/org/repo/pull/42", "branch": "symphony/sma-1"})
        self.review_pr = self._patch("review_pr")
        self.merge_pr = self._patch("merge_pr")

    def tearDown(self):
        self.env_patch.stop()
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _patch(self, name, **kwargs):
        patcher = mock.patch.object(hook, name, **kwargs)
        mocked = patcher.start()
        self.addCleanup(patcher.stop)
        return mocked

    def _write_decision(self, stage, payload):
        with open(os.path.join(hook.DECISION_DIR, f"decision_{stage}.json"), "w") as f:
            json.dump(payload, f)

    def _env(self, **kv):
        return mock.patch.dict(os.environ, kv, clear=False)

    # --- shared -----------------------------------------------------------

    def test_no_decision_file_is_a_noop(self):
        with self._env(SYMPHONY_STAGE="pm"):
            hook.main()
        self.move_state.assert_not_called()
        self.comment.assert_not_called()

    def test_blocked_comments_but_does_not_move_state(self):
        self._write_decision("pm", {"status": "blocked", "summary": "need more info"})
        with self._env(SYMPHONY_STAGE="pm", SYMPHONY_NEXT_STATE="Design"):
            hook.main()
        self.move_state.assert_not_called()
        self.comment.assert_called_once()
        self.assertIn("blocked", self.comment.call_args.args[2])

    # --- pm -----------------------------------------------------------------

    def test_pm_done_creates_subissues_and_advances(self):
        self._write_decision(
            "pm",
            {"status": "done", "summary": "refined", "subtasks": [{"title": "part 1", "description": "d1"}]},
        )
        with self._env(SYMPHONY_STAGE="pm", SYMPHONY_NEXT_STATE="Design"):
            hook.main()
        self.create_subissue.assert_called_once_with(
            "fake-key", "team-uuid-1", "issue-uuid-1", "part 1", "d1"
        )
        self.move_state.assert_called_once_with("fake-key", "issue-uuid-1", "state-Design")
        # decision file is consumed
        self.assertFalse(os.path.exists(os.path.join(hook.DECISION_DIR, "decision_pm.json")))

    def test_pm_done_with_no_subtasks_still_advances(self):
        self._write_decision("pm", {"status": "done", "summary": "refined, no split needed", "subtasks": []})
        with self._env(SYMPHONY_STAGE="pm", SYMPHONY_NEXT_STATE="Design"):
            hook.main()
        self.create_subissue.assert_not_called()
        self.move_state.assert_called_once_with("fake-key", "issue-uuid-1", "state-Design")

    # --- architect ------------------------------------------------------------

    def test_architect_done_advances_to_development(self):
        self._write_decision("architect", {"status": "done", "summary": "designed it"})
        with self._env(SYMPHONY_STAGE="architect", SYMPHONY_NEXT_STATE="Development"):
            hook.main()
        self.move_state.assert_called_once_with("fake-key", "issue-uuid-1", "state-Development")

    # --- dev -----------------------------------------------------------------

    def test_dev_done_with_changes_opens_pr_and_advances(self):
        self._write_decision("dev", {"status": "done", "summary": "implemented it"})
        with self._env(SYMPHONY_STAGE="dev", SYMPHONY_NEXT_STATE="Review"):
            hook.main()
        self.open_pr.assert_called_once()
        self.move_state.assert_called_once_with("fake-key", "issue-uuid-1", "state-Review")
        with open(hook.PIPELINE_STATE_PATH) as f:
            state = json.load(f)
        self.assertEqual(state["number"], 42)
        self.assertEqual(state["url"], "https://github.com/org/repo/pull/42")

    def test_dev_done_with_no_changes_does_not_advance(self):
        self.open_pr.return_value = None
        self._write_decision("dev", {"status": "done", "summary": "nothing to change"})
        with self._env(SYMPHONY_STAGE="dev", SYMPHONY_NEXT_STATE="Review"):
            hook.main()
        self.move_state.assert_not_called()

    # --- qa ------------------------------------------------------------------

    def _seed_pr_on_record(self):
        hook.save_pipeline_state({"number": 42, "url": "https://github.com/org/repo/pull/42"})

    def _qa_env(self, **extra):
        base = {
            "SYMPHONY_STAGE": "qa",
            "SYMPHONY_NEXT_STATE": "Done",
            "SYMPHONY_FAIL_STATE": "Development",
            "SYMPHONY_BOUNCE_LIMIT_STATE": "Blocked",
            "SYMPHONY_BOUNCE_CAP": "3",
        }
        base.update(extra)
        return self._env(**base)

    def test_qa_pass_approves_merges_and_moves_to_done(self):
        self._seed_pr_on_record()
        self._write_decision("qa", {"status": "done", "result": "pass", "summary": "looks good"})
        with self._qa_env():
            hook.main()
        self.review_pr.assert_called_once_with(42, "APPROVE", "looks good")
        self.merge_pr.assert_called_once_with(42)
        self.move_state.assert_called_once_with("fake-key", "issue-uuid-1", "state-Done")

    def test_qa_fail_under_cap_bounces_to_development(self):
        self._seed_pr_on_record()
        self._write_decision("qa", {"status": "done", "result": "fail", "summary": "missing tests"})
        with self._qa_env():
            hook.main()
        self.review_pr.assert_called_once_with(42, "REQUEST_CHANGES", "missing tests")
        self.merge_pr.assert_not_called()
        self.move_state.assert_called_once_with("fake-key", "issue-uuid-1", "state-Development")
        with open(hook.PIPELINE_STATE_PATH) as f:
            state = json.load(f)
        self.assertEqual(state["qa_bounce_count"], 1)

    def test_qa_fail_over_cap_moves_to_blocked(self):
        hook.save_pipeline_state({"number": 42, "qa_bounce_count": 3})
        self._write_decision("qa", {"status": "done", "result": "fail", "summary": "still broken"})
        with self._qa_env():
            hook.main()
        self.move_state.assert_called_once_with("fake-key", "issue-uuid-1", "state-Blocked")

    def test_qa_without_pr_on_record_skips_github(self):
        self._write_decision("qa", {"status": "done", "result": "pass", "summary": "n/a"})
        with self._qa_env():
            hook.main()
        self.review_pr.assert_not_called()
        self.merge_pr.assert_not_called()
        self.move_state.assert_not_called()


if __name__ == "__main__":
    unittest.main()
