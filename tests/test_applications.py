"""Application lifecycle and export regression tests."""

import unittest

from pydantic import ValidationError

from backend.models.application import Application, ApplicationStatusUpdate
from backend.routers.applications import _csv_safe


class ApplicationModelTests(unittest.TestCase):
    def test_prepared_application_has_truthful_status(self) -> None:
        application = Application(
            company="Example",
            role="Engineer",
            url="https://example.test/jobs/1",
            status="ready_to_review",
        )

        self.assertEqual("ready_to_review", application.status)

    def test_unknown_status_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            ApplicationStatusUpdate(status="maybe")


class CsvSafetyTests(unittest.TestCase):
    def test_formula_prefixes_are_neutralized(self) -> None:
        for value in ("=cmd()", "+1+1", "-2+3", "@SUM(A1:A2)", "  =1+1"):
            with self.subTest(value=value):
                self.assertTrue(_csv_safe(value).startswith("'"))

    def test_normal_values_are_unchanged(self) -> None:
        self.assertEqual("Example, Inc.", _csv_safe("Example, Inc."))
        self.assertEqual(92, _csv_safe(92))


if __name__ == "__main__":
    unittest.main()
