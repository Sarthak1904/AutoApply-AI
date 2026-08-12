"""Validated request bodies for API operations not represented by domain models."""

from pydantic import BaseModel, Field


class KnowledgeUpdate(BaseModel):
    content: str = Field(default="", max_length=200_000)


class JobDescriptionRequest(BaseModel):
    job_description: str = Field(min_length=1, max_length=100_000)


class CoverLetterRequest(BaseModel):
    job_description: str = Field(default="", max_length=100_000)
    company: str = Field(default="", max_length=500)
    role: str = Field(default="", max_length=500)
