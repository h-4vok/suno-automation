export type LifecycleLabel =
  | "backlog"
  | "blocked"
  | "codex-ready"
  | "codex-in-progress"
  | "codex-review"
  | "codex-rework"
  | "codex-needs-attention";

export interface IssueSnapshot {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly title: string;
  readonly body: string | null;
  readonly labels: readonly string[];
}

export interface DependencySnapshot {
  readonly issueNumber: number;
  readonly state: "open" | "closed";
}

export interface PromotionContext {
  readonly actor: string;
  readonly trustedActors: ReadonlySet<string>;
  readonly dependencies: readonly DependencySnapshot[];
  readonly dependencyCycle: boolean;
  readonly activeClaim: boolean;
  readonly linkedImplementationPr: boolean;
  readonly contractDecisionComplete: boolean;
  readonly contractBlockers: readonly string[];
}

export interface PromotionDecision {
  readonly eligible: boolean;
  readonly blockers: readonly string[];
  readonly plannedLabels: readonly string[];
  readonly commentRequired: boolean;
}

export interface PromotionMutationPort {
  updateLabels(labels: readonly string[]): Promise<void>;
  addComment(comment: string): Promise<void>;
}

export interface PromotionRequest {
  readonly issue: IssueSnapshot;
  readonly context: PromotionContext;
  readonly eventId: string;
  readonly attemptId: string;
  readonly dryRun?: boolean;
}

export function evaluatePromotion({
  issue,
  context,
}: Omit<PromotionRequest, "eventId" | "attemptId" | "dryRun">): PromotionDecision {
  const blockers: string[] = [];
  const body = issue.body?.trim() ?? "";
  const lifecycle = issue.labels.filter((label): label is LifecycleLabel =>
    [
      "backlog",
      "blocked",
      "codex-ready",
      "codex-in-progress",
      "codex-review",
      "codex-rework",
      "codex-needs-attention",
    ].includes(label),
  );

  if (issue.state !== "open") blockers.push("issue-closed");
  if (issue.labels.includes("type:epic")) blockers.push("epic");
  if (!issue.labels.some((label) => /^priority:p[0-2]$/.test(label)))
    blockers.push("missing-priority");
  if (issue.labels.includes("blocked")) blockers.push("blocked");
  if (!context.trustedActors.has(context.actor)) blockers.push("untrusted-actor");
  if (context.activeClaim) blockers.push("active-claim");
  if (context.linkedImplementationPr) blockers.push("linked-implementation-pr");
  if (!context.contractDecisionComplete) blockers.push("incomplete-contract");
  blockers.push(...context.contractBlockers);
  if (context.dependencyCycle) blockers.push("dependency-cycle");
  if (context.dependencies.some((dependency) => dependency.state !== "closed"))
    blockers.push("open-dependency");
  if (lifecycle.some((label) => !["backlog", "blocked", "codex-ready"].includes(label)))
    blockers.push("active-lifecycle");
  if (!body) blockers.push("blank-contract");
  const eligible = blockers.length === 0;
  return {
    eligible,
    blockers,
    plannedLabels: eligible
      ? [
          ...issue.labels.filter(
            (label) =>
              ![
                "backlog",
                "blocked",
                ...lifecycle.filter((item) => item !== "backlog" && item !== "blocked"),
              ].includes(label),
          ),
          "codex-ready",
        ]
      : issue.labels,
    commentRequired: !eligible,
  };
}

export async function promoteIssue(
  request: PromotionRequest,
  port: PromotionMutationPort,
  alreadyDelivered: (eventId: string, attemptId: string) => boolean,
): Promise<PromotionDecision> {
  const decision = evaluatePromotion(request);
  if (request.dryRun || alreadyDelivered(request.eventId, request.attemptId)) return decision;
  const comment = `codex-eligibility event=${request.eventId} attempt=${request.attemptId} result=${decision.eligible ? "eligible" : "blocked"}${decision.blockers.length ? ` blockers=${decision.blockers.join(",")}` : ""}`;
  if (decision.eligible) await port.updateLabels(decision.plannedLabels);
  else await port.addComment(comment);
  return decision;
}
