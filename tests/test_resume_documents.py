import tempfile
import unittest
from pathlib import Path
from zipfile import is_zipfile

from backend.models.profile import PersonalInfo, UserProfile, WorkExperience
from backend.services.resume_documents import ResumeDocumentGenerator, apply_tailoring


class ResumeDocumentTests(unittest.TestCase):
    def setUp(self):
        self.profile = UserProfile(
            personal=PersonalInfo(first_name="Ada", last_name="Lovelace", email="ada@example.test"),
            skills=["Python", "Mathematics"],
            work_experience=[
                WorkExperience(company="Analytical Engines", title="Engineer", description="Built reliable programs")
            ],
        )

    def test_tailoring_reorders_known_skills_and_never_adds_employment(self):
        tailored = apply_tailoring(
            self.profile,
            {
                "summary": "Engineer focused on reliable analytical systems.",
                "highlighted_skills": ["Mathematics", "Imaginary Skill"],
                "experience_bullets": [
                    {"company": "Invented Corp", "title": "CEO", "bullets": ["Did not happen"]},
                    {"company": "Analytical Engines", "title": "Engineer", "bullets": ["Built reliable programs at scale"]},
                ],
            },
        )

        self.assertEqual(["Mathematics", "Python"], tailored.skills)
        self.assertEqual(1, len(tailored.work_experience))
        self.assertEqual("Built reliable programs at scale", tailored.work_experience[0].description)

    def test_renders_private_pdf_and_docx(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = ResumeDocumentGenerator(Path(temp_dir)).render(self.profile, "version-1", "Ada Resume")
            pdf = Path(paths["pdf_path"])
            docx = Path(paths["docx_path"])
            self.assertEqual(b"%PDF", pdf.read_bytes()[:4])
            self.assertTrue(is_zipfile(docx))
            self.assertEqual(0o600, pdf.stat().st_mode & 0o777)


if __name__ == "__main__":
    unittest.main()
