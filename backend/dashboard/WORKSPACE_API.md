# Dashboard workspace API contract

The dashboard keeps the original application-history API as its always-on
fallback. Workspace features use the following REST endpoints; a `404` or
`501` from the overview/packet endpoints renders an explanatory empty state
rather than breaking history.

## Existing history endpoints

- `GET /api/applications/?limit=500` — returns application rows.
- `PUT /api/applications/{application_id}/status` — payload:
  `{"status":"ready_to_review|applied|interview|rejected|offer|withdrawn","notes":"optional"}`.
- `GET /api/applications/export` — downloads the CSV export.

## Workspace reads

- `GET /api/workspace/overview` — returns one object with optional arrays:
  `queue`, `reminders`, `policies`, `resumes`, `answers`, `receipts`, and
  `relationships` (or `contacts`). Queue items include `application_id`,
  `title`, `reason`, and optional `due_at`; policies include `id`, `label`,
  `description`, and `enabled`; resumes include `id`, `name`, `created_at`,
  and `is_default`.
- `GET /api/workspace/applications/{application_id}/packet` — returns
  `application`, `job_description`, `notes`, `contacts`, `interviews`, and
  `follow_ups` (or `reminders`). Timeline objects use `title`, optional
  `company`/`contact_name`, and optional `due_at`.

## Workspace writes

- `PATCH /api/workspace/resumes/{resume_id}` — payload:
  `{"is_default":true}`.
- `PUT /api/workspace/policies` — payload:
  `{"policies":[{"id":"policy-id","enabled":true}]}`.
- `POST /api/workspace/applications/{application_id}/receipt` — payload:
  `{"confirmed_at":"2026-07-23T12:34:56.000Z"}`. This records a manual
  submission confirmation; it must not submit an application.
- `POST /api/workspace/applications/{application_id}/relationships` — payload:
  `{"name":"Hiring manager","type":"contact|interview"}`.
- `POST /api/workspace/applications/{application_id}/follow-ups` — payload:
  `{"due_at":"2026-07-23T12:34:56.000Z","note":"Send thank-you note"}`.

The UI intentionally does not fabricate workspace records when these endpoints
are unavailable.
