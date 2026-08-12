import unittest
from unittest.mock import Mock, patch

from backend.models.form_schema import FormField, FormSchema
from backend.models.profile import LegalInfo, PersonalInfo, UserProfile
from backend.routers.autofill import autofill
from backend.services.local_mapper import LocalFieldMapper, answer_similarity


class LocalFieldMapperTests(unittest.TestCase):
    def setUp(self):
        self.profile = UserProfile(
            personal=PersonalInfo(
                first_name="Ada",
                last_name="Lovelace",
                email="ada@example.test",
            ),
            legal=LegalInfo(authorized_to_work=True, gender="Female"),
        )

    def test_maps_direct_profile_fields_and_upload_without_ai(self):
        schema = FormSchema(
            url="https://jobs.example.test/apply",
            resume_version_id="resume-2",
            fields=[
                FormField(id="first", type="text", label="First name"),
                FormField(id="email", type="email", label="Email address"),
                FormField(id="auth", type="select", label="Authorized to work?", options=["Yes", "No"]),
                FormField(id="resume", type="file", label="Resume"),
            ],
        )

        result = LocalFieldMapper.map_fields(schema, self.profile)

        self.assertEqual([], result.unresolved)
        self.assertEqual(
            [(item.field_id, item.action, item.value) for item in result.instructions],
            [
                ("first", "fill", "Ada"),
                ("email", "fill", "ada@example.test"),
                ("auth", "select", "Yes"),
                ("resume", "upload", "resume-2"),
            ],
        )

    def test_sensitive_fields_require_review_by_default(self):
        schema = FormSchema(
            url="https://example.test/apply",
            fields=[FormField(id="gender", type="select", label="Gender", options=["Female", "Male"])],
        )

        result = LocalFieldMapper.map_fields(schema, self.profile)

        self.assertEqual("skip", result.instructions[0].action)
        self.assertIn("sensitive", result.instructions[0].reason)

    def test_fixed_policy_and_learned_mapping_take_precedence(self):
        schema = FormSchema(
            url="https://jobs.example.test/apply",
            platform="example",
            fields=[
                FormField(id="salary", type="text", label="Expected salary"),
                FormField(id="nickname", type="text", label="Preferred name"),
            ],
        )
        result = LocalFieldMapper.map_fields(
            schema,
            self.profile,
            policies=[{"field_key": "salary_expectation", "action": "fixed", "fixed_value": "120000"}],
            learned_mappings=[
                {"field_label": "Preferred name", "platform": "example", "value": "Ada"}
            ],
        )

        self.assertEqual(["120000", "Ada"], [item.value for item in result.instructions])

    def test_reuses_only_similar_approved_answers(self):
        schema = FormSchema(
            url="https://example.test/apply",
            fields=[FormField(id="interest", type="textarea", label="Why do you want to work here?")],
        )
        result = LocalFieldMapper.map_fields(
            schema,
            self.profile,
            answer_entries=[
                {
                    "id": 7,
                    "question": "Why do you want to work here?",
                    "answer": "The product and role closely match my systems experience.",
                    "approved": 1,
                }
            ],
        )

        self.assertEqual("answer_vault:7", result.instructions[0].source)
        self.assertGreater(answer_similarity("Why this role?", "Why are you interested in this role?"), 0.4)

    @patch("backend.routers.autofill._save_generated_answers")
    @patch("backend.routers.autofill._load_corrections", return_value=[])
    @patch("backend.routers.autofill._load_knowledge", return_value="")
    @patch("backend.routers.autofill._load_profile")
    @patch("backend.routers.autofill.get_database")
    @patch("backend.routers.autofill.FieldMapper.map_fields")
    def test_autofill_does_not_call_ai_when_every_field_is_local(
        self,
        ai_map,
        get_database,
        load_profile,
        _load_knowledge,
        _load_corrections,
        _save_answers,
    ):
        load_profile.return_value = self.profile
        database = Mock()
        database.get_field_policies.return_value = []
        database.get_learned_mappings.return_value = []
        database.get_answers.return_value = []
        get_database.return_value = database
        schema = FormSchema(
            url="https://example.test/apply",
            fields=[FormField(id="email", type="email", label="Email")],
        )

        response = autofill(schema)

        self.assertEqual(1, response.local_count)
        self.assertEqual(0, response.ai_count)
        self.assertEqual(1, response.ready_count)
        self.assertEqual(0, response.review_count)
        self.assertEqual(0, response.skipped_count)
        self.assertFalse(response.instructions[0].review_required)
        ai_map.assert_not_called()


if __name__ == "__main__":
    unittest.main()
