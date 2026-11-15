"""Synthetic negative controls for exact-main workflow evidence."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "verify_main_workflows", Path(__file__).with_name("verify-main-workflows.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SHA = "a" * 40


def fixture():
    return [{"name": name, "headSha": SHA, "event": "push",
             "status": "completed", "conclusion": "success", "databaseId": i + 1}
            for i, name in enumerate(sorted(module.REQUIRED))]


class QualificationEvidenceTests(unittest.TestCase):
    def test_exact_success(self):
        self.assertEqual(module.verify(SHA, fixture()), [])

    def test_missing_workflow_fails(self):
        self.assertTrue(module.verify(SHA, fixture()[:-1]))

    def test_prior_sha_cannot_substitute(self):
        runs = fixture()
        runs[0]["headSha"] = "b" * 40
        self.assertTrue(module.verify(SHA, runs))

    def test_pull_request_cannot_substitute(self):
        runs = fixture()
        runs[0]["event"] = "pull_request"
        self.assertTrue(module.verify(SHA, runs))

    def test_pending_cannot_substitute(self):
        runs = fixture()
        runs[0]["status"] = "in_progress"
        self.assertTrue(module.verify(SHA, runs))

    def test_failed_cannot_substitute(self):
        runs = fixture()
        runs[0]["conclusion"] = "failure"
        self.assertTrue(module.verify(SHA, runs))

    def test_missing_run_id_fails(self):
        runs = fixture()
        runs[0].pop("databaseId")
        self.assertTrue(module.verify(SHA, runs))

    def test_invalid_sha_fails(self):
        self.assertTrue(module.verify("abc", fixture()))

    def test_later_failed_run_supersedes_earlier_success(self):
        runs = fixture()
        latest = dict(runs[0], databaseId=1000, conclusion="failure")
        runs.append(latest)
        self.assertTrue(module.verify(SHA, runs))

    def test_later_pending_run_supersedes_earlier_success(self):
        runs = fixture()
        latest = dict(runs[0], databaseId=1000,
                      status="in_progress", conclusion=None)
        runs.append(latest)
        self.assertTrue(module.verify(SHA, runs))

    def test_older_failure_does_not_mask_latest_success(self):
        runs = fixture()
        older = dict(runs[0], databaseId=0, conclusion="failure")
        runs.append(older)
        self.assertEqual(module.verify(SHA, runs), [])

    def test_unrelated_runs_do_not_affect_result(self):
        runs = fixture()
        runs.append({"name": "Unrelated", "headSha": SHA, "event": "push"})
        self.assertEqual(module.verify(SHA, runs), [])


if __name__ == "__main__":
    unittest.main()
