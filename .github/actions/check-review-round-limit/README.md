# Check review-round limit

This composite action runs the `check-review-round-limit` activity. It is not
yet wired into the respond-review workflow; workflow and Terraform integration
are separate follow-up work. See the [design](../../../docs/design/cap-review-response-rounds.md).

The activity revalidates the live PR and review feedback, then counts distinct
commit SHAs from submitted reviews by the configured automated reviewers since
the latest human removal of `human-required`. Dismissed reviews count; PR-author
reviews do not. An old triggering review cannot restart a reset epoch.

## Inputs

| Input | Purpose |
| --- | --- |
| `token` | Required developer App installation token. |
| `repo-owner`, `repo-name`, `pr-number`, `review-id` | Required repository, PR, and triggering review identifiers. |
| `max-review-rounds` | Non-negative safe decimal integer; empty defaults to 8 and 0 disables the numerical cap. |
| `reviewer-logins` | JSON array of automated reviewer logins used for accounting, not authorization; empty uses the activity's defaults. |
| `resolver-token` | Optional token for expanding organization teams. |
| `escalation-assignee` | Optional explicit assignee for an escalation. |
| `admin-assignees` | JSON array of administrator logins or organization/team references for escalation assignment. |
| `run-url` | Optional workflow run URL included in the escalation comment. |

## Outputs and escalation

`proceed` tells the caller whether to run the response container; `limit`,
`round-count`, and `epoch` report the parsed limit, count, and reset event ID
when available. The count is empty when unavailable or when the cap is disabled.

At the threshold, the activity pauses responses with `human-required`, posts
or updates a bot-authored epoch comment with a bounded unresolved-thread
summary, and attempts to assign the configured humans. Assignment and summary
failures are reported but do not permit a response; counting, labeling, and
comment failures fail closed. An existing `human-required` label also pauses
responses when the numerical cap is disabled. After a human resolves the
escalation, they remove the label and obtain a fresh authorized review.
