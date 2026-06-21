# Roadmap — deliberately out of scope

These were consciously excluded to keep the build focused and defensible. Each is
a real production concern, noted here rather than half-built.

## Data model
- **`template_versions`** — templates are currently edited in place (with an
  `audit_log` row per change). Production should version template bodies so a
  finalized note can point at the exact prompt that produced it. We snapshot the
  system prompt onto `note_versions.system_prompt_snapshot` as a partial mitigation.
- **MRN / patient identity & merge** — patients are matched on
  (lower first, lower last, dob), which the brief mandates but which is
  production-unsafe (two real people can collide). A real system keys on an MRN
  and supports merge/unmerge.
- **PHI read-access audit** — we audit admin *mutations*; HIPAA also wants a log
  of who *viewed* which patient record. Add a read-access log + retention.
- **`audit_log` partitioning** — partition by month once volume grows.
- **No soft-delete columns** — nothing in scope deletes (deactivation uses
  `active`, template "delete" uses `archived`).

## Multi-tenancy
- **No `organizations` / `org_id`** — single clinic. Multi-tenant would add an
  org boundary to every table and every query's isolation filter.

## AI / retrieval
- **Provider writing-style learning** — adapt phrasing to each provider from
  their saved-note history.
- **Suggestion-acceptance analytics** — track how often AI-suggested codes
  survive to the saved version (requires persisting the full suggestion set).
- **Vertex AI for real PHI** — switch the Gemini calls to Vertex AI (same
  `google-genai` SDK, auth/config change) to operate under a Google BAA. Verify
  current Vertex config + HIPAA terms from Google's docs before relying on this.

## Infrastructure scale-up (see infra/DEPLOY.md)
- EC2 in a **private** subnet behind an **ALB**, with a **NAT gateway** for
  egress and a **Secrets Manager VPC endpoint**.
- Frontend via **S3 + CloudFront** instead of nginx static serving.
- Read replicas / connection proxy (RDS Proxy) as request volume grows.
