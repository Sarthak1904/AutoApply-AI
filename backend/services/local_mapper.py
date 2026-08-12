"""Fast, deterministic form mapping before invoking an LLM.

This module deliberately uses a small, auditable vocabulary.  It handles direct
profile facts, saved field policies, learned corrections, resume uploads, and
approved answer-vault matches.  Anything ambiguous is left for ``FieldMapper``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from difflib import SequenceMatcher
import re
from typing import Any, Iterable
from urllib.parse import urlparse

from backend.models.form_schema import FillInstruction, FormField, FormSchema
from backend.models.profile import UserProfile


_WORDS = re.compile(r"[a-z0-9]+")
_SENSITIVE = {
    "date_of_birth",
    "nationality",
    "gender",
    "ethnicity",
    "veteran_status",
    "disability_status",
}


@dataclass
class LocalMapResult:
    """Instructions resolved locally and the fields that still need AI."""

    instructions: list[FillInstruction] = field(default_factory=list)
    unresolved: list[FormField] = field(default_factory=list)


def normalize_question(value: str | None) -> str:
    """Normalize labels for policy, vault, and learned-mapping comparisons."""
    return " ".join(_WORDS.findall((value or "").casefold()))


def field_text(form_field: FormField) -> str:
    """Return all stable human-readable hints attached to a field."""
    return normalize_question(
        " ".join(
            value
            for value in (
                form_field.label,
                form_field.aria_label,
                form_field.name,
                form_field.placeholder,
                form_field.id,
            )
            if value
        )
    )


def _tokens(value: str) -> set[str]:
    stop = {
        "a", "an", "and", "are", "do", "for", "how", "in", "is", "of",
        "on", "or", "the", "this", "to", "what", "why", "with", "you", "your",
    }
    return {word for word in _WORDS.findall(value.casefold()) if word not in stop}


def answer_similarity(left: str, right: str) -> float:
    """Score two application questions without an embedding dependency."""
    left_normalized = normalize_question(left)
    right_normalized = normalize_question(right)
    if not left_normalized or not right_normalized:
        return 0.0
    left_tokens, right_tokens = _tokens(left_normalized), _tokens(right_normalized)
    union = left_tokens | right_tokens
    overlap = len(left_tokens & right_tokens) / len(union) if union else 0.0
    sequence = SequenceMatcher(None, left_normalized, right_normalized).ratio()
    return (overlap * 0.7) + (sequence * 0.3)


def best_answer(question: str, entries: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    """Return a sufficiently similar approved vault answer."""
    winner: dict[str, Any] | None = None
    winner_score = 0.0
    for entry in entries:
        if entry.get("approved") in (0, False, "false"):
            continue
        score = answer_similarity(question, str(entry.get("question") or entry.get("title") or ""))
        if score > winner_score:
            winner, winner_score = entry, score
    return winner if winner is not None and winner_score >= 0.58 else None


def _profile_values(profile: UserProfile) -> dict[str, tuple[Any, str]]:
    p = profile.personal
    address = p.address
    full_name = " ".join(filter(None, (p.first_name, p.last_name))).strip()
    latest_work = profile.work_experience[0] if profile.work_experience else None
    latest_school = profile.education[0] if profile.education else None
    values: dict[str, tuple[Any, str]] = {
        "first_name": (p.first_name, "profile.personal.first_name"),
        "last_name": (p.last_name, "profile.personal.last_name"),
        "full_name": (full_name, "profile.personal"),
        "email": (p.email, "profile.personal.email"),
        "phone": (p.phone, "profile.personal.phone"),
        "linkedin": (p.linkedin, "profile.personal.linkedin"),
        "github": (p.github, "profile.personal.github"),
        "portfolio": (p.portfolio, "profile.personal.portfolio"),
        "street": (address.street, "profile.personal.address.street"),
        "city": (address.city, "profile.personal.address.city"),
        "state": (address.state, "profile.personal.address.state"),
        "zip": (address.zip, "profile.personal.address.zip"),
        "country": (address.country, "profile.personal.address.country"),
        "date_of_birth": (p.date_of_birth, "profile.personal.date_of_birth"),
        "nationality": (p.nationality, "profile.personal.nationality"),
        "authorized_to_work": (profile.legal.authorized_to_work, "profile.legal.authorized_to_work"),
        "sponsorship_required": (profile.legal.sponsorship_required, "profile.legal.sponsorship_required"),
        "veteran_status": (profile.legal.veteran_status, "profile.legal.veteran_status"),
        "disability_status": (profile.legal.disability_status, "profile.legal.disability_status"),
        "gender": (profile.legal.gender, "profile.legal.gender"),
        "ethnicity": (profile.legal.ethnicity, "profile.legal.ethnicity"),
        "salary_expectation": (profile.preferences.salary_expectation, "profile.preferences.salary_expectation"),
        "notice_period": (profile.preferences.notice_period, "profile.preferences.notice_period"),
        "start_date": (profile.preferences.start_date, "profile.preferences.start_date"),
        "willing_to_relocate": (profile.preferences.willing_to_relocate, "profile.preferences.willing_to_relocate"),
        "current_company": (latest_work.company if latest_work else None, "profile.work_experience.0.company"),
        "current_title": (latest_work.title if latest_work else None, "profile.work_experience.0.title"),
        "school": (latest_school.institution if latest_school else None, "profile.education.0.institution"),
        "degree": (latest_school.degree if latest_school else None, "profile.education.0.degree"),
        "field_of_study": (latest_school.field if latest_school else None, "profile.education.0.field"),
    }
    return values


_ALIASES: list[tuple[str, tuple[str, ...]]] = [
    ("email", ("email", "e mail")),
    ("phone", ("phone", "mobile", "telephone")),
    ("linkedin", ("linkedin",)),
    ("github", ("github",)),
    ("portfolio", ("portfolio", "personal website", "website url")),
    ("first_name", ("first name", "given name")),
    ("last_name", ("last name", "surname", "family name")),
    ("full_name", ("full name", "legal name", "your name", "candidate name")),
    ("zip", ("zip", "postal code", "postcode")),
    ("street", ("street address", "address line 1", "address 1")),
    ("city", ("city", "town")),
    ("state", ("state", "province", "region")),
    ("country", ("country",)),
    ("authorized_to_work", ("authorized to work", "work authorization", "legally authorized")),
    ("sponsorship_required", ("require sponsorship", "need sponsorship", "visa sponsorship")),
    ("salary_expectation", ("salary expectation", "expected salary", "desired compensation")),
    ("notice_period", ("notice period",)),
    ("start_date", ("available start", "start date", "date available")),
    ("willing_to_relocate", ("willing to relocate", "open to relocation")),
    ("current_company", ("current company", "current employer", "most recent employer")),
    ("current_title", ("current title", "current position", "most recent title")),
    ("school", ("school", "university", "institution")),
    ("field_of_study", ("field of study", "major")),
    ("degree", ("degree",)),
    ("date_of_birth", ("date of birth", "birth date", "dob")),
    ("nationality", ("nationality", "citizenship")),
    ("veteran_status", ("veteran",)),
    ("disability_status", ("disability", "disabled")),
    ("gender", ("gender", "gender identity")),
    ("ethnicity", ("ethnicity", "race")),
]


def classify_field(form_field: FormField) -> str | None:
    """Classify an untrusted page field using conservative phrase matches."""
    text = field_text(form_field)
    for category, aliases in _ALIASES:
        if any(alias in text for alias in aliases):
            return category
    return None


def _option_value(value: Any, options: list[str]) -> str | None:
    if isinstance(value, bool):
        candidates = ("yes", "true", "authorized", "i agree") if value else ("no", "false", "not authorized")
        for option in options:
            normalized = normalize_question(option)
            if normalized in candidates or any(candidate == normalized for candidate in candidates):
                return option
        return "true" if value else "false" if not options else None

    wanted = normalize_question(str(value))
    if not options:
        return str(value)
    exact = next((option for option in options if normalize_question(option) == wanted), None)
    if exact:
        return exact
    containing = next(
        (option for option in options if wanted and (wanted in normalize_question(option) or normalize_question(option) in wanted)),
        None,
    )
    return containing


def _policy_for(category: str | None, text: str, policies: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    candidates = []
    normalized_category = normalize_question(category)
    for policy in policies:
        key = normalize_question(str(policy.get("field_key") or policy.get("category") or policy.get("field_label") or ""))
        if key and (key == normalized_category or key == text or key in text):
            candidates.append(policy)
    return candidates[-1] if candidates else None


def _learned_for(text: str, form_schema: FormSchema, mappings: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    hostname = (urlparse(form_schema.url).hostname or "").casefold()
    for mapping in reversed(list(mappings)):
        mapping_label = normalize_question(str(mapping.get("field_label") or mapping.get("field_key") or ""))
        mapping_domain = str(mapping.get("domain") or "").casefold()
        mapping_platform = str(mapping.get("platform") or "").casefold()
        if mapping_label and (mapping_label in text or answer_similarity(text, mapping_label) >= 0.82):
            if mapping_domain and mapping_domain not in hostname:
                continue
            if mapping_platform and mapping_platform != (form_schema.platform or "").casefold():
                continue
            return mapping
    return None


class LocalFieldMapper:
    """Resolve safe, repeatable fields without an AI request."""

    @classmethod
    def map_fields(
        cls,
        form_schema: FormSchema,
        profile: UserProfile,
        policies: Iterable[dict[str, Any]] = (),
        learned_mappings: Iterable[dict[str, Any]] = (),
        answer_entries: Iterable[dict[str, Any]] = (),
    ) -> LocalMapResult:
        values = _profile_values(profile)
        result = LocalMapResult()

        for form_field in form_schema.fields:
            text = field_text(form_field)
            category = classify_field(form_field)
            policy = _policy_for(category, text, policies)
            policy_action = str((policy or {}).get("action") or (policy or {}).get("mode") or "").casefold()

            if not policy and category in _SENSITIVE:
                result.instructions.append(FillInstruction(
                    field_id=form_field.id,
                    action="skip",
                    confidence="high",
                    source="policy.default_sensitive",
                    reason="Review this sensitive field before filling",
                ))
                continue
            if policy_action in {"never", "ask", "ask_every_time"}:
                reason = "Autofill policy says never fill" if policy_action == "never" else "Autofill policy requires review"
                result.instructions.append(FillInstruction(
                    field_id=form_field.id, action="skip", confidence="high", source="policy", reason=reason
                ))
                continue

            fixed_value = (policy or {}).get("fixed_value", (policy or {}).get("value"))
            learned = _learned_for(text, form_schema, learned_mappings)
            value: Any = fixed_value if fixed_value not in (None, "") else None
            source = "policy.fixed" if value is not None else None
            if value is None and learned:
                value = learned.get("value") or learned.get("user_value")
                source = "learned_mapping"

            if form_field.type.casefold() == "file":
                selected = getattr(form_schema, "resume_version_id", None)
                result.instructions.append(FillInstruction(
                    field_id=form_field.id,
                    action="upload",
                    value=selected or "resume",
                    confidence="high",
                    source=f"resume_version:{selected}" if selected else "resume.master",
                ))
                continue

            if value is None and category and category in values:
                value, source = values[category]

            if value not in (None, ""):
                option = _option_value(value, form_field.options)
                if option is None:
                    result.unresolved.append(form_field)
                    continue
                field_type = form_field.type.casefold()
                action = "select" if field_type == "select" else "check" if field_type in {"checkbox", "radio"} else "fill"
                if form_field.max_length is not None and len(option) > form_field.max_length:
                    result.unresolved.append(form_field)
                    continue
                result.instructions.append(FillInstruction(
                    field_id=form_field.id,
                    action=action,
                    value=option,
                    confidence="high" if source and source.startswith("profile") else "medium",
                    source=source,
                ))
                continue

            if form_field.type.casefold() in {"text", "textarea"} and text:
                answer = best_answer(text, answer_entries)
                if answer and answer.get("answer"):
                    answer_value = str(answer["answer"])
                    if form_field.max_length is None or len(answer_value) <= form_field.max_length:
                        result.instructions.append(FillInstruction(
                            field_id=form_field.id,
                            action="fill",
                            value=answer_value,
                            confidence="medium",
                            source=f"answer_vault:{answer.get('id', 'saved')}",
                        ))
                        continue

            result.unresolved.append(form_field)

        return result
