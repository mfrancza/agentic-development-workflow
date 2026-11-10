import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const helper = new URL("../../../docker/scripts/lib/reply-only-rereview.sh", import.meta.url).pathname;
const rootComment = { id: 1, user: { login: "Reviewer[bot]", type: "Bot" }, in_reply_to_id: null };
const reply = { id: 2, user: { login: "Developer[bot]", type: "Bot" }, in_reply_to_id: 1 };
const pr = { state: "open", draft: false, user: { login: "developer[bot]", type: "Bot" }, head: { sha: "abc", repo: { full_name: "owner/repo" } }, labels: [{ name: "agent:review" }] };
const page = (resolved = false) => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: resolved, comments: { nodes: [{ databaseId: 1 }] } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } });

function run(opts: { before?: unknown; after?: unknown; live?: unknown; threads?: unknown; identity?: string; failSnapshot?: boolean; addsFail?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reply-review-"));
  try {
    for (const [name, data] of Object.entries({ before: opts.before ?? [[rootComment]], after: opts.after ?? [[rootComment], [reply]], liveFixture: opts.live ?? pr, threadFixture: opts.threads ?? [page()] })) writeFileSync(join(dir, name), JSON.stringify(data));
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", `
      source "$HELPER"
      log() { echo "$*"; }
      gh() {
        echo "$*" >> "$DIR/calls"
        if [[ "$1" == api && "$2" == graphql ]]; then cat "$DIR/threadFixture"; return; fi
        if [[ "$1" == api && "$*" == *comments* ]]; then
          if [[ ! -f "$DIR/read" ]]; then touch "$DIR/read"; [[ "$FAIL_SNAPSHOT" == 1 ]] && return 1; cat "$DIR/before"; else cat "$DIR/after"; fi; return
        fi
        if [[ "$1" == api ]]; then cat "$DIR/liveFixture"; return; fi
        if [[ "$*" == *--add-label* ]]; then
          n=0; [[ -f "$DIR/adds" ]] && n=$(cat "$DIR/adds"); n=$((n+1)); echo "$n" > "$DIR/adds"; (( n > ADDS_FAIL )); return
        fi
      }
      if reply_review_snapshot "$DIR/snapshot"; then reply_review_request "$DIR/snapshot" abc; fi
    `], { encoding: "utf8", env: { ...process.env, DIR: dir, HELPER: helper, GITHUB_REPO: "owner/repo", GITHUB_PR_NUMBER: "1", REVIEWER_BOT_LOGIN: opts.identity ?? "reviewer[bot]", FAIL_SNAPSHOT: opts.failSnapshot ? "1" : "0", ADDS_FAIL: String(opts.addsFail ?? 0) } });
    let calls = ""; try { calls = readFileSync(join(dir, "calls"), "utf8"); } catch { /* disabled */ }
    expect(result.status, result.stderr).toBe(0);
    return { output: result.stdout + result.stderr, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("reply-only reviewer request", () => {
  it("cycles an enrolled label once for a new reply across pages", () => {
    const { calls, output } = run();
    expect(calls, output).toContain("--remove-label");
    expect(calls.match(/--remove-label/g)).toHaveLength(1);
    expect(calls.match(/--add-label/g)).toHaveLength(1);
    expect(calls).toContain("graphql --paginate --slurp");
    expect(calls).not.toMatch(/push|ready/);
  });
  it("follows reply chains and paginated thread roots", () => {
    const firstPage = page();
    firstPage.data.repository.pullRequest.reviewThreads.nodes = [];
    firstPage.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage = true;
    const result = run({ before: [[rootComment, reply]], after: [[rootComment, reply], [{ ...reply, id: 3, in_reply_to_id: 2 }]], threads: [firstPage, page()] });
    expect(result.calls).toContain("--remove-label");
  });
  it.each([
    { before: [[rootComment, reply]] },
    { after: [[rootComment, { ...reply, user: { login: "human", type: "User" } }]] },
    { after: [[rootComment, { ...reply, in_reply_to_id: 99 }]] },
    { after: [[{ ...rootComment, user: { login: "other" } }, reply]] },
    { threads: [page(true)] },
    { identity: "" },
    { failSnapshot: true },
    { threads: [] },
  ])("skips without complete qualifying evidence %#", (opts) => expect(run(opts).calls).not.toContain("--remove-label"));
  it.each([
    { ...pr, state: "closed" }, { ...pr, draft: true },
    { ...pr, head: { ...pr.head, sha: "moved" } },
    { ...pr, head: { ...pr.head, repo: { full_name: "fork/repo" } } },
    { ...pr, labels: [] }, { ...pr, labels: [...pr.labels, { name: "human-required" }] },
  ])("guards live state %#", (live) => expect(run({ live }).calls).not.toContain("--remove-label"));
  it("attempts restoration once after a failed re-add", () => {
    const result = run({ addsFail: 2 });
    expect(result.calls.match(/--add-label/g)).toHaveLength(2);
    expect(result.output).toContain("re-apply agent:review manually");
    expect(result.output).toContain("restoration failed");
  });
});

 it("forwards the configured identity through the response workflow", () => {
  const action = readFileSync(new URL("../../actions/run-agent/action.yml", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../../workflows/agent-respond-review-reusable.yml", import.meta.url), "utf8");
  expect(action).toContain("reviewer-bot-login:");
  expect(action).toContain('REVIEWER_BOT_LOGIN="${_REVIEWER_BOT_LOGIN}"');
  expect(workflow).toContain("reviewer-bot-login: 'mfrancza-reviewer-agent[bot]'");
});
