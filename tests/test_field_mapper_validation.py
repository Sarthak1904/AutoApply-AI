import unittest

from backend.models.form_schema import FormField, FormSchema
from backend.services.field_mapper import FieldMapper


class FieldMapperValidationTests(unittest.TestCase):
    def test_llm_instructions_are_limited_to_safe_known_fields(self):
        schema = FormSchema(
            url="https://example.test/apply",
            fields=[
                FormField(id="email", type="email", max_length=30),
                FormField(id="country", type="select", options=["United States", "Canada"]),
                FormField(id="work_auth", type="radio", options=["Yes", "No"]),
                FormField(id="resume", type="file"),
            ],
        )
        result = [
            {"field_id": "other-dom-element", "action": "fill", "value": "unsafe"},
            {"field_id": "email", "action": "fill", "value": "a@example.test"},
            {"field_id": "email", "action": "fill", "value": "second@example.test"},
            {"field_id": "country", "action": "select", "value": "canada"},
            {"field_id": "work_auth", "action": "check", "value": "Maybe"},
            {"field_id": "resume", "action": "upload", "value": "resume"},
        ]

        instructions = FieldMapper._validate_instructions(result, schema)

        self.assertEqual(
            [(item.field_id, item.action, item.value) for item in instructions],
            [
                ("email", "fill", "a@example.test"),
                ("country", "select", "Canada"),
                ("resume", "upload", "resume"),
            ],
        )

    def test_llm_instructions_reject_wrong_actions_and_values_over_limits(self):
        schema = FormSchema(
            url="https://example.test/apply",
            fields=[
                FormField(id="short-answer", type="text", max_length=3),
                FormField(id="country", type="select", options=["Canada"]),
                FormField(id="resume", type="file"),
            ],
        )
        result = [
            {"field_id": "short-answer", "action": "fill", "value": "long"},
            {"field_id": "country", "action": "fill", "value": "Canada"},
            {"field_id": "country", "action": "select", "value": "Mexico"},
            {"field_id": "resume", "action": "upload", "value": "cover-letter"},
            {"field_id": "short-answer", "action": "skip", "confidence": "low"},
        ]

        instructions = FieldMapper._validate_instructions(result, schema)

        self.assertEqual([(item.field_id, item.action) for item in instructions], [("short-answer", "skip")])
