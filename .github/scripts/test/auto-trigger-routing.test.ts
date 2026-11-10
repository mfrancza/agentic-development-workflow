import { readFileSync } from "node:fs";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it } from "vitest";

const workflows = new URL("../../../.github/workflows/", import.meta.url);
const caller = readFileSync(new URL("agent-auto-trigger.yml", workflows), "utf8");
const reusable = readFileSync(
  new URL("agent-auto-trigger-reusable.yml", workflows),
  "utf8",
);

const routeMatch = reusable.match(/  route:\n[\s\S]*?    outputs:\n      transition: >-\n\s*\${{([\s\S]*?)}}/);
if (!routeMatch) throw new Error("Could not extract the reusable route expression");
const routeExpression = new Parser(
  new Lexer(routeMatch[1]).lex().tokens,
  ["inputs", "vars", "github"],
  [],
).parse();

const developer = "developer[bot]";
const authorList = JSON.stringify([developer, "alice", "other[bot]"]);
const marker = "<!-- authored-by-model: example -->";
const defaultInputs = {
  "event-name": "pull_request",
  "event-action": "opened",
  "issue-label-name": "",
  "issue-labels": "[]",
  "pr-is-draft": false,
  "pr-body": "",
  "pr-head-repository": "owner/repo",
  "pr-author-login": "alice",
  "developer-bot-login": developer,
  "sender-login": "alice",
};
const defaultVars = {
  AUTO_TRIGGER_AGENTS: JSON.stringify({ groom: true, design: true, developer: true, review: true }),
  AUTO_REVIEW_AUTHORS: authorList,
};

type Overrides = {
  inputs?: Partial<typeof defaultInputs> & Record<string, string | boolean>;
  vars?: Partial<Record<keyof typeof defaultVars, string | undefined>>;
  repository?: string;
};

function route({ inputs = {}, vars = {}, repository = "owner/repo" }: Overrides = {}): string {
  const context = JSON.parse(JSON.stringify({
    inputs: { ...defaultInputs, ...inputs },
    vars: { ...defaultVars, ...vars },
    github: { repository },
  }), data.reviver) as data.Dictionary;
  return new Evaluator(routeExpression, context).evaluate().coerceString();
}

describe("agent-auto-trigger routing contract", () => {
  it("forwards the retained inputs and removes retired inputs from both contracts", () => {
    expect(caller.match(/uses: .*agent-auto-trigger-reusable\.yml/g)).toHaveLength(1);
    expect(caller).toContain("event-name: ${{ github.event_name }}");
    expect(caller).toContain("event-action: ${{ github.event.action }}");
    expect(caller).toContain("issue-labels: ${{ toJSON(github.event.issue.labels.*.name || fromJSON('[]')) }}");
    expect(caller).toContain("developer-bot-login: mfrancza-developer-agent[bot]");
    expect(reusable).toMatch(/developer-bot-login:\n(?:.*\n)*?\s+required: true/);
    expect(caller).toContain("pr-is-draft: ${{ github.event.pull_request.draft || false }}");
    expect(caller).toContain("pr-body: ${{ github.event.pull_request.body || '' }}");
    expect(caller).toContain("pr-head-repository: ${{ github.event.pull_request.head.repo.full_name || '' }}");
    expect(caller).toContain("pr-author-login: ${{ github.event.pull_request.user.login || '' }}");
    for (const retired of ["pr-head-ref", "pr-author-is-bot"]) {
      expect(caller).not.toContain(retired);
      expect(reusable).not.toContain(retired);
    }
    expect(caller).toMatch(/pull_request:\n\s+types: \[opened, ready_for_review\]/);
    expect(caller).toMatch(/issues:\n\s+types: \[opened, labeled, unlabeled, closed\]/);
    expect(caller).not.toContain("transition:");
  });

  it.each([
    ["listed human opening", {}, "auto-review"],
    ["listed non-developer bot opening", { inputs: { "pr-author-login": "other[bot]" } }, "auto-review"],
    ["developer opening without marker", { inputs: { "pr-author-login": developer } }, ""],
    ["developer opening with marker", { inputs: { "pr-author-login": developer, "pr-body": marker } }, ""],
    ["developer draft opening", { inputs: { "pr-author-login": developer, "pr-is-draft": true, "pr-body": marker } }, ""],
    ["developer ready with marker", { inputs: { "event-action": "ready_for_review", "pr-author-login": developer, "pr-body": marker } }, "auto-review"],
    ["developer ready without marker", { inputs: { "event-action": "ready_for_review", "pr-author-login": developer } }, ""],
    ["human ready without marker", { inputs: { "event-action": "ready_for_review" } }, "auto-review"],
    ["other bot ready without marker", { inputs: { "event-action": "ready_for_review", "pr-author-login": "other[bot]" } }, "auto-review"],
    ["human draft opening", { inputs: { "pr-is-draft": true } }, ""],
    ["other bot draft opening", { inputs: { "pr-author-login": "other[bot]", "pr-is-draft": true } }, ""],
    ["human draft ready", { inputs: { "event-action": "ready_for_review", "pr-is-draft": true } }, ""],
    ["other bot draft ready", { inputs: { "event-action": "ready_for_review", "pr-author-login": "other[bot]", "pr-is-draft": true } }, ""],
    ["developer draft ready with marker", { inputs: { "event-action": "ready_for_review", "pr-author-login": developer, "pr-is-draft": true, "pr-body": marker } }, ""],
    ["unlisted author on agent branch", { inputs: { "pr-author-login": "unlisted", "pr-head-ref": "agent/issue-1", "pr-body": marker } }, ""],
    ["unlisted author on design branch", { inputs: { "event-action": "ready_for_review", "pr-author-login": "unlisted", "pr-head-ref": "design/issue-1", "pr-body": marker } }, ""],
    ["listed author on docs branch", { inputs: { "pr-head-ref": "docs/issue-1" } }, "auto-review"],
    ["fork head", { inputs: { "pr-head-repository": "fork/repo" } }, ""],
    ["absent head", { inputs: { "pr-head-repository": "" } }, ""],
    ["absent author", { inputs: { "pr-author-login": "" }, vars: { AUTO_REVIEW_AUTHORS: '[""]' } }, ""],
    ["empty array", { vars: { AUTO_REVIEW_AUTHORS: "[]" } }, ""],
    ["empty configuration", { vars: { AUTO_REVIEW_AUTHORS: "" } }, ""],
    ["missing configuration", { vars: { AUTO_REVIEW_AUTHORS: undefined } }, ""],
    ["disabled review", { vars: { AUTO_TRIGGER_AGENTS: '{"review":false}' } }, ""],
    ["missing review switch", { vars: { AUTO_TRIGGER_AGENTS: "{}" } }, ""],
    ["missing switch config", { vars: { AUTO_TRIGGER_AGENTS: "" } }, ""],
    ["case insensitive member", { inputs: { "pr-author-login": "ALICE" } }, "auto-review"],
    ["case insensitive developer timing", { inputs: { "pr-author-login": "DEVELOPER[bot]" } }, ""],
    ["case insensitive developer ready", { inputs: { "event-action": "ready_for_review", "pr-author-login": "DEVELOPER[bot]", "pr-body": marker } }, "auto-review"],
    ["substring is not membership", { inputs: { "pr-author-login": "ali" } }, ""],
    ["JSON string cannot match substring", { vars: { AUTO_REVIEW_AUTHORS: '"alice-other"' } }, ""],
    ["JSON string cannot match exact login", { vars: { AUTO_REVIEW_AUTHORS: '"alice"' } }, ""],
    ["JSON object", { vars: { AUTO_REVIEW_AUTHORS: '{"alice":true}' } }, ""],
    ["JSON number", { vars: { AUTO_REVIEW_AUTHORS: "42" } }, ""],
    ["JSON boolean", { vars: { AUTO_REVIEW_AUTHORS: "true" } }, ""],
    ["JSON null", { vars: { AUTO_REVIEW_AUTHORS: "null" } }, ""],
    ["developer omitted despite marker", { inputs: { "event-action": "ready_for_review", "pr-author-login": developer, "pr-body": marker }, vars: { AUTO_REVIEW_AUTHORS: '["alice"]' } }, ""],
    ["sender differs from listed author", { inputs: { "sender-login": "unlisted" } }, "auto-review"],
    ["listed sender cannot enroll unlisted author", { inputs: { "sender-login": "alice", "pr-author-login": "unlisted" } }, ""],
    ["unsupported event", { inputs: { "event-action": "synchronize" } }, ""],
  ] satisfies [string, Overrides, string][])("routes %s", (_name, overrides, expected) => {
    expect(route(overrides)).toBe(expected);
  });

  it.each(["[", "not json", "[\"alice\",]"])("fails visibly for malformed authors %s", (authors) => {
    expect(() => route({ vars: { AUTO_REVIEW_AUTHORS: authors } })).toThrow();
  });

  it.each([
    ["groom issue", { "event-action": "opened" }, "auto-groom"],
    ["skip draft groom", { "event-action": "opened", "issue-labels": '["draft"]' }, ""],
    ["design plan", { "event-action": "labeled", "issue-label-name": "plan" }, "auto-design"],
    ["implement do", { "event-action": "labeled", "issue-label-name": "do" }, "auto-developer-do"],
    ["skip draft do", { "event-action": "labeled", "issue-label-name": "do", "issue-labels": '["draft"]' }, ""],
    ["undraft", { "event-action": "unlabeled", "issue-label-name": "draft" }, "auto-developer-undraft"],
    ["unblock", { "event-action": "closed" }, "auto-developer-unblock"],
    ["unrelated label", { "event-action": "labeled", "issue-label-name": "other" }, ""],
  ])("preserves %s", (_name, inputs, expected) => {
    expect(route({ inputs: { ...inputs, "event-name": "issues" }, vars: { AUTO_REVIEW_AUTHORS: "malformed" } })).toBe(expected);
  });

  it.each([
    ["groom", "opened", "", "groom"],
    ["design", "labeled", "plan", "design"],
    ["developer do", "labeled", "do", "developer"],
    ["developer undraft", "unlabeled", "draft", "developer"],
    ["developer unblock", "closed", "", "developer"],
  ])("honors disabled %s issue switch", (_name, action, label, flag) => {
    expect(route({ inputs: { "event-name": "issues", "event-action": action, "issue-label-name": label }, vars: { AUTO_TRIGGER_AGENTS: JSON.stringify({ [flag]: false }) } })).toBe("");
  });

  it("preserves authorization and the no-checkout label-writing boundary", () => {
    expect(reusable).toContain("if: needs.route.outputs.transition != ''");
    expect(reusable).toContain("principal: ${{ inputs.sender-login }}");
    expect(reusable).toContain("skip-gate: ${{ needs.route.outputs.transition == 'auto-review' }}");
    for (const transition of ["auto-groom", "auto-design", "auto-developer-do", "auto-developer-undraft", "auto-review", "auto-developer-unblock"]) {
      const job = reusable.match(new RegExp(`  ${transition}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:|$)`));
      expect(job).not.toBeNull();
      expect(job![1]).toContain("needs: [route, authorize]");
      expect(job![1]).toContain(`if: needs.route.outputs.transition == '${transition}'`);
      if (transition === "auto-review") {
        expect(job![1]).not.toContain("uses: actions/checkout");
        expect(job![1]).toContain("uses: actions/create-github-app-token@");
        expect(job![1]).toContain('gh pr edit "$PR_NUMBER" --repo "$GITHUB_REPO" --add-label "agent:review"');
      }
    }
  });
});
