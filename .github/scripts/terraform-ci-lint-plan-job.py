"""
Static lint for the Terraform CI plan job trust-boundary invariants.

Parses .github/workflows/terraform-ci-reusable.yml as YAML, restricts
inspection to the plan job's steps, and fails if any step contains:

  - uses: ./.github/actions/<name>  (only ./_base/.github/actions/ is
    permitted in the plan job so composite actions always load from the
    trusted base-branch checkout)
  - working-directory: terraform    (only _pr/terraform is permitted in the
    plan job so Terraform CLI steps operate on the PR-head checkout)

The apply job is explicitly excluded: it does not use the dual-checkout
pattern, so working-directory: terraform there is correct and expected.

See docs/design/terraform-ci-plan-checkout-isolation.md Decision 3.
"""

import sys
import yaml

with open('.github/workflows/terraform-ci-reusable.yml', 'r') as f:
    workflow = yaml.safe_load(f)

plan_job = workflow.get('jobs', {}).get('plan', {})
steps = plan_job.get('steps', [])

errors = []

for step in steps:
    step_name = step.get('name', '(unnamed)')

    # Check for disallowed ./.github/actions/ references.
    # Only ./_base/.github/actions/ is permitted in the plan job so that
    # composite actions always load from the trusted base-branch checkout.
    uses = step.get('uses', '') or ''
    if './.github/actions/' in str(uses):
        errors.append(
            f"plan job step {step_name!r}: "
            f"uses './.github/actions/' — only './_base/.github/actions/' is permitted "
            f"in the plan job (found: {uses!r}). "
            f"See docs/design/terraform-ci-plan-checkout-isolation.md Decision 3."
        )

    # Check for disallowed bare 'working-directory: terraform'.
    # Only 'working-directory: _pr/terraform' is permitted in the plan job
    # so that Terraform CLI steps operate on the PR-head checkout.
    wd = step.get('working-directory', '') or ''
    if str(wd) == 'terraform':
        errors.append(
            f"plan job step {step_name!r}: "
            f"working-directory is 'terraform' — only '_pr/terraform' is permitted "
            f"in the plan job. "
            f"See docs/design/terraform-ci-plan-checkout-isolation.md Decision 3."
        )

if errors:
    for err in errors:
        print(f"::error::{err}")
    print('')
    print(
        'FAILED: The plan job contains steps that violate the trust-boundary '
        'invariant. The apply job is not in scope for this lint — see Decision 3 '
        'in docs/design/terraform-ci-plan-checkout-isolation.md.'
    )
    sys.exit(1)

print(f"OK: plan job has {len(steps)} step(s); no trust-boundary violations found.")
