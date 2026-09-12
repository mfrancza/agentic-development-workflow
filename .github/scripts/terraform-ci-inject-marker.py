"""
Inject a sentinel marker step into the PR-head copy of the
terraform-plan-comment composite action (_pr/ only, never pushed back).

The marker step is prepended as the first step of
_pr/.github/actions/terraform-plan-comment/action.yml.  If the plan job (or
the trust-boundary test) ever regresses to loading uses: ./.github/actions/
(resolving against _pr/ instead of _base/), the marker step runs and creates
marker-ran.txt in GITHUB_WORKSPACE.  The assertion step that follows then fails
loudly.

Inserting the marker as the first step ensures it runs before any step that
could fail (e.g. the API-call step), so the sentinel file is written whenever
the _pr/ action is loaded.

See docs/design/terraform-ci-plan-checkout-isolation.md Decision 3 and the
accompanying runtime-marker-test job in
.github/workflows/test-terraform-ci-trust-boundary.yml.
"""

# Marker step to prepend as the first step in the composite action.
# Uses shell: bash and run: so it is valid across all runner OSes.
# The touch command creates the sentinel file that the assertion checks.
marker_step = (
    "    - name: MARKER CHECK (must not run — proves _pr/ was loaded instead of _base/)\n"
    "      shell: bash\n"
    "      run: |\n"
    '        echo "MARKER-PR-HEAD-RAN"\n'
    '        touch "$GITHUB_WORKSPACE/marker-ran.txt"\n'
)

path = '_pr/.github/actions/terraform-plan-comment/action.yml'
with open(path, 'r') as f:
    content = f.read()

# Insert the marker immediately after the "  steps:" line so it
# becomes the first composite-action step.  The sentinel "  steps:\n"
# (2-space indent) appears exactly once in the file under runs:, so
# the replace(…, 1) is unambiguous.
if '  steps:\n' not in content:
    print('ERROR: expected "  steps:\\n" in action.yml — injection point not found.')
    raise SystemExit(1)

content = content.replace('  steps:\n', '  steps:\n' + marker_step, 1)

with open(path, 'w') as f:
    f.write(content)

print(f'Marker step injected as first step in {path}')
