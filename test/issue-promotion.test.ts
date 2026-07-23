import { describe, expect, it, vi } from "vitest";
import {
  evaluatePromotion,
  promoteIssue,
  type IssueSnapshot,
  type PromotionContext,
} from "../src/domain/issue-promotion.js";

const body = `## Problem
Users need safe promotion.
## Outcome
Eligible issues enter the local queue.
## Scope
- In: evaluate issues.
- Out: claims.
## Constraints and safety
Fail closed and never access Suno.
## Acceptance criteria
- [ ] Given an eligible issue when evaluated then it is promoted.
## Implementation notes
Use a pure evaluator and injected mutation port.
## Verification
- [ ] Focused tests and full gate.
## Dependencies / rollout
No blocking dependencies.
## Open decisions
None.`;

const issue: IssueSnapshot = {
  number: 41,
  state: "open",
  title: "work",
  body,
  labels: ["enhancement", "backlog", "priority:p0"],
};
const context: PromotionContext = {
  actor: "trusted",
  trustedActors: new Set(["trusted"]),
  dependencies: [],
  dependencyCycle: false,
  activeClaim: false,
  linkedImplementationPr: false,
  contractDecisionComplete: true,
  contractBlockers: [],
};

describe("issue promotion policy", () => {
  it("promotes a complete eligible contract and keeps manual validation eligible", () => {
    const result = evaluatePromotion({
      issue: { ...issue, labels: [...issue.labels, "manual-validation"] },
      context,
    });
    expect(result.eligible).toBe(true);
    expect(result.plannedLabels).toContain("codex-ready");
    expect(result.plannedLabels).not.toContain("backlog");
  });

  it("keeps an already promoted issue eligible for an idempotent re-evaluation", () => {
    const result = evaluatePromotion({
      issue: { ...issue, labels: ["enhancement", "priority:p0", "codex-ready"] },
      context,
    });
    expect(result.eligible).toBe(true);
    expect(result.plannedLabels).toEqual(["enhancement", "priority:p0", "codex-ready"]);
  });

  it("lets the interviewer decide whether optional sections still leave a complete contract", () => {
    const result = evaluatePromotion({
      issue: { ...issue, body: "## Outcome\nNo rollout required." },
      context: {
        ...context,
        contractDecisionComplete: false,
        contractBlockers: ["missing-verification"],
      },
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining(["incomplete-contract", "missing-verification"]),
    );
  });

  it.each([
    ["closed", { issue: { state: "closed" as const } }, "issue-closed"],
    ["epic", { issue: { labels: [...issue.labels, "type:epic"] } }, "epic"],
    [
      "dependency",
      { context: { dependencies: [{ issueNumber: 40, state: "open" as const }] } },
      "open-dependency",
    ],
    ["actor", { context: { actor: "unknown" } }, "untrusted-actor"],
    ["claim", { context: { activeClaim: true } }, "active-claim"],
  ])(
    "rejects %s with an actionable blocker",
    (
      _name,
      overrides: { issue?: Partial<IssueSnapshot>; context?: Partial<PromotionContext> },
      blocker,
    ) => {
      const result = evaluatePromotion({
        issue: { ...issue, ...overrides.issue },
        context: { ...context, ...overrides.context },
      });
      expect(result.eligible).toBe(false);
      expect(result.blockers).toContain(blocker);
    },
  );

  it("is dry-run and duplicate delivery safe", async () => {
    const port = { updateLabels: vi.fn(), addComment: vi.fn() };
    const delivered = vi.fn(() => false);
    await promoteIssue(
      { issue, context, eventId: "event-1", attemptId: "attempt-1", dryRun: true },
      port,
      delivered,
    );
    expect(port.updateLabels).not.toHaveBeenCalled();
    expect(port.addComment).not.toHaveBeenCalled();
    delivered.mockReturnValue(true);
    await promoteIssue(
      { issue, context, eventId: "event-1", attemptId: "attempt-1" },
      port,
      delivered,
    );
    expect(port.updateLabels).not.toHaveBeenCalled();
  });

  it("comments blockers without copying issue content", async () => {
    const port = { updateLabels: vi.fn(), addComment: vi.fn() };
    await promoteIssue(
      {
        issue: { ...issue, body: body.replace("None.", "Choose secret-token") },
        context: {
          ...context,
          contractDecisionComplete: false,
          contractBlockers: ["open-decision"],
        },
        eventId: "e",
        attemptId: "a",
      },
      port,
      () => false,
    );
    expect(port.addComment).toHaveBeenCalledWith(expect.stringContaining("open-decision"));
    expect(port.addComment).toHaveBeenCalledWith(expect.not.stringContaining("secret-token"));
  });
});
