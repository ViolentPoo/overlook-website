# Streaming Service Request Maintenance

The `streaming-service-request` Issue Form is consolidated by a GitHub-hosted
workflow. Matching is deliberately conservative: normalized names must be equal or
must resolve through an explicitly reviewed alias in
`streaming-service-aliases.json`. The automation does not use fuzzy matching,
parent-company relationships, or inferred regional equivalence.

## Alias Registry

Add aliases only when maintainers have verified that every name identifies the same
service product. Keep regional products as separate entries unless equivalence is
confirmed. Each entry uses this shape:

```json
{
  "canonical": "Current service name",
  "aliases": ["Verified former name"]
}
```

Conflicting aliases fail the workflow rather than risking an incorrect merge.

## Manual Correction

If a request was consolidated incorrectly:

1. Add the `deduplication-exempt` label to the incorrectly closed issue.
2. Remove the `duplicate` label, reopen that issue, and remove the automation
   comment containing its canonical issue link.
3. Remove the corresponding automation detail comment from the prior canonical
   issue if its copied context should no longer appear there.
4. Run `Deduplicate Streaming Service Requests` manually for the prior canonical
   issue number to recalculate its derived request count.

The count is derived from stable relationship markers on duplicate issues. Workflow
reruns therefore do not increment a mutable counter or create duplicate comments.
