import { posix, win32 } from "node:path";

import { z } from "zod";

export const LOOP_SLOT_IDS = ["worker-1", "worker-2"] as const;
export const LIFECYCLE_LABELS = [
  "backlog",
  "blocked",
  "codex-ready",
  "codex-in-progress",
  "codex-review",
  "codex-rework",
  "codex-needs-attention",
] as const;

const SafeIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const DeliveryKeySchema = z
  .string()
  .min(9)
  .max(247)
  .superRefine((value, context) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        !parsed.every((component) => SafeIdentifierSchema.safeParse(component).success) ||
        JSON.stringify(parsed) !== value
      ) {
        context.addIssue({ code: "custom", message: "Delivery key is not canonical." });
      }
    } catch {
      context.addIssue({ code: "custom", message: "Delivery key is not canonical." });
    }
  });
export const GitHubLoginSchema = z
  .string()
  .trim()
  .min(1)
  .max(39)
  .regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i);
export const GitRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const AbsolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (value) => /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(value),
    "Path must be absolute on the host.",
  );

function normalizedPortablePath(value: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value)) {
    return win32.normalize(value.replaceAll("/", "\\")).toLowerCase();
  }
  return posix.normalize(value);
}
export const CommitShaSchema = z.string().regex(/^[a-f\d]{7,64}$/i);
export const TimestampSchema = z.iso.datetime({ offset: true });
const ErrorCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const SafeFindingTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !/(?:[A-Za-z]:[\\/]|^\/|^\\\\|gh[pousr]_|AIza|sk-[A-Za-z0-9]|BEGIN [A-Z ]*PRIVATE KEY|cookie\s*[:=]|authorization\s*[:=])/i.test(
        value,
      ),
    "Finding text contains sensitive or machine-local data.",
  );

export const LoopSlotConfigSchema = z
  .object({
    id: z.enum(LOOP_SLOT_IDS),
    projectId: SafeIdentifierSchema,
    worktreePath: AbsolutePathSchema,
  })
  .strict();
export type LoopSlotConfig = z.infer<typeof LoopSlotConfigSchema>;

export const LoopConfigSchema = z
  .object({
    dispatcher: z
      .object({
        leaseSeconds: z.number().int().min(60).max(86_400).default(7_200),
        mutexSeconds: z.number().int().min(5).max(300).default(60),
        pollMinutes: z.literal(15).default(15),
      })
      .strict(),
    repository: z
      .object({
        baseBranch: GitRefSchema.default("main"),
        name: z.string().trim().min(1).max(100),
        owner: GitHubLoginSchema,
      })
      .strict(),
    retention: z
      .object({
        completedAttempts: z.number().int().min(1).max(5_000).default(500),
        days: z.number().int().min(1).max(365).default(90),
      })
      .strict(),
    slots: z.tuple([
      LoopSlotConfigSchema.extend({ id: z.literal("worker-1") }),
      LoopSlotConfigSchema.extend({ id: z.literal("worker-2") }),
    ]),
    stateDirectory: AbsolutePathSchema,
    trustedLogins: z.array(GitHubLoginSchema).min(1),
    verificationKeyEnv: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .default("CODEX_LOOP_VERIFICATION_KEY"),
    version: z.literal(1),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.slots[0].projectId === config.slots[1].projectId) {
      context.addIssue({
        code: "custom",
        message: "Worker project identifiers must be distinct.",
        path: ["slots", 1, "projectId"],
      });
    }
    if (
      normalizedPortablePath(config.slots[0].worktreePath) ===
      normalizedPortablePath(config.slots[1].worktreePath)
    ) {
      context.addIssue({
        code: "custom",
        message: "Worker worktree paths must be distinct.",
        path: ["slots", 1, "worktreePath"],
      });
    }
    const normalizedLogins = config.trustedLogins.map((login) => login.toLowerCase());
    if (new Set(normalizedLogins).size !== normalizedLogins.length) {
      context.addIssue({
        code: "custom",
        message: "Trusted logins must be unique.",
        path: ["trustedLogins"],
      });
    }
  });

export type LoopConfig = z.infer<typeof LoopConfigSchema>;
export type LoopSlotId = (typeof LOOP_SLOT_IDS)[number];

export const IssueCandidateSchema = z
  .object({
    author: GitHubLoginSchema.optional(),
    createdAt: TimestampSchema,
    dependencies: z.array(
      z
        .object({
          number: z.number().int().positive(),
          state: z.enum(["open", "closed", "unknown"]),
        })
        .strict(),
    ),
    labels: z.array(z.string().trim().min(1).max(100)),
    linkedPullRequest: z
      .object({
        baseRef: GitRefSchema,
        draft: z.boolean(),
        headRef: GitRefSchema,
        headSha: CommitShaSchema,
        headRepositoryOwner: GitHubLoginSchema,
        isCrossRepository: z.boolean(),
        number: z.number().int().positive(),
        state: z.enum(["open", "closed", "merged"]),
        url: z.url(),
      })
      .strict()
      .optional(),
    number: z.number().int().positive(),
    promotion: z
      .object({
        actor: GitHubLoginSchema,
        eventId: z.literal("contract-promoted"),
      })
      .strict()
      .optional(),
    state: z.enum(["open", "closed"]),
    title: z.string().trim().min(1).max(256),
    url: z.url(),
  })
  .strict();

export type IssueCandidate = z.infer<typeof IssueCandidateSchema>;

export const AttemptStageSchema = z.enum([
  "reserved",
  "claimed",
  "launch-pending",
  "running",
  "prepared",
  "implemented",
  "committed",
  "verified",
  "pushed",
  "pr-linked",
  "review",
  "attention",
  "completed",
]);
export type AttemptStage = z.infer<typeof AttemptStageSchema>;

export const VerificationFindingSchema = z
  .object({
    confidence: z.enum(["high", "medium", "low"]),
    id: SafeIdentifierSchema,
    location: SafeFindingTextSchema.pipe(z.string().max(240)),
    requiredAction: SafeFindingTextSchema,
    severity: z.enum(["P0", "P1", "P2", "P3"]),
    summary: SafeFindingTextSchema,
  })
  .strict();
export type VerificationFinding = z.infer<typeof VerificationFindingSchema>;

export const AdversarialReviewSchema = z
  .object({
    findings: z.array(VerificationFindingSchema).max(100),
    status: z.enum(["pass", "block", "not-applicable", "error"]),
    version: z.literal(1),
  })
  .strict();
export type AdversarialReview = z.infer<typeof AdversarialReviewSchema>;

export const VerificationVerdictSchema = z
  .object({
    attemptId: SafeIdentifierSchema,
    commands: z.array(
      z
        .object({
          durationMs: z.number().int().nonnegative(),
          name: z.enum(["focused", "full-gate", "build", "config", "mutation"]),
          status: z.enum(["pass", "block", "not-applicable", "error"]),
        })
        .strict(),
    ),
    commitSha: CommitShaSchema,
    createdAt: TimestampSchema,
    findings: z.array(VerificationFindingSchema).max(100),
    signature: z.string().regex(/^[a-f\d]{64}$/),
    slotId: z.enum(LOOP_SLOT_IDS),
    status: z.enum(["pass", "block", "error"]),
    version: z.literal(1),
  })
  .strict();
export type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;

export const ReworkRequestSchema = z
  .object({
    approvedFeedbackIds: z.array(SafeIdentifierSchema).min(1).max(100),
    baseCommit: CommitShaSchema,
    eventId: SafeIdentifierSchema,
    issueNumber: z.number().int().positive(),
    prNumber: z.number().int().positive(),
    requestedAt: TimestampSchema,
    requestedBy: GitHubLoginSchema,
    status: z.enum(["queued", "claimed", "completed", "rejected"]),
  })
  .strict();
export type ReworkRequest = z.infer<typeof ReworkRequestSchema>;

export const AttemptRecordSchema = z
  .object({
    attemptId: SafeIdentifierSchema,
    branchName: GitRefSchema.optional(),
    commitSha: CommitShaSchema.optional(),
    createdAt: TimestampSchema,
    errorCode: ErrorCodeSchema.optional(),
    issueNumber: z.number().int().positive(),
    issueUrl: z.url(),
    leaseExpiresAt: TimestampSchema,
    parentAttemptId: SafeIdentifierSchema.optional(),
    pullRequest: z
      .object({
        draft: z.literal(true),
        number: z.number().int().positive(),
        url: z.url(),
      })
      .strict()
      .optional(),
    repairPasses: z.number().int().min(0).max(2).default(0),
    reworkEventId: SafeIdentifierSchema.optional(),
    selectionReason: z.enum(["rework", "priority-p0", "priority-p1", "priority-p2"]),
    slotId: z.enum(LOOP_SLOT_IDS),
    stage: AttemptStageSchema,
    supersededByAttemptId: SafeIdentifierSchema.optional(),
    threadId: SafeIdentifierSchema.optional(),
    trigger: z.enum(["implementation", "rework"]),
    updatedAt: TimestampSchema,
    verification: VerificationVerdictSchema.optional(),
  })
  .strict();
export type AttemptRecord = z.infer<typeof AttemptRecordSchema>;

export const SlotStateSchema = z
  .object({
    attemptId: SafeIdentifierSchema.optional(),
    id: z.enum(LOOP_SLOT_IDS),
    leaseExpiresAt: TimestampSchema.optional(),
    status: z.enum(["free", "reserved", "running", "attention"]),
  })
  .strict()
  .superRefine((slot, context) => {
    const shouldHaveAttempt = slot.status !== "free";
    if (shouldHaveAttempt !== (slot.attemptId !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Occupied slots require an attempt and free slots cannot reference one.",
        path: ["attemptId"],
      });
    }
    if (shouldHaveAttempt !== (slot.leaseExpiresAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Occupied slots require a lease and free slots cannot retain one.",
        path: ["leaseExpiresAt"],
      });
    }
  });
export type SlotState = z.infer<typeof SlotStateSchema>;

export const AuditEventSchema = z
  .object({
    at: TimestampSchema,
    attemptId: SafeIdentifierSchema,
    errorCode: ErrorCodeSchema.optional(),
    eventId: SafeIdentifierSchema,
    issueNumber: z.number().int().positive(),
    result: z.enum(["pending", "success", "blocked", "attention", "failure"]),
    slotId: z.enum(LOOP_SLOT_IDS),
    stage: AttemptStageSchema,
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const MaintenanceAuditEventSchema = z
  .object({
    at: TimestampSchema,
    eventId: SafeIdentifierSchema,
    removedAttempts: z.number().int().nonnegative(),
    result: z.enum(["success", "failure"]),
  })
  .strict();
export type MaintenanceAuditEvent = z.infer<typeof MaintenanceAuditEventSchema>;

export const ReworkDecisionEventSchema = z
  .object({
    at: TimestampSchema,
    eventId: SafeIdentifierSchema,
    issueNumber: z.number().int().positive(),
    result: z.enum(["queued", "rejected"]),
    safeReason: ErrorCodeSchema.optional(),
  })
  .strict();
export type ReworkDecisionEvent = z.infer<typeof ReworkDecisionEventSchema>;

export const LoopStateSchema = z
  .object({
    attempts: z.array(AttemptRecordSchema),
    audit: z.array(AuditEventSchema),
    deliveredEvents: z.array(DeliveryKeySchema),
    maintenanceAudit: z.array(MaintenanceAuditEventSchema).default([]),
    reworkAudit: z.array(ReworkDecisionEventSchema).default([]),
    reworkRequests: z.array(ReworkRequestSchema),
    slots: z.tuple([
      SlotStateSchema.safeExtend({ id: z.literal("worker-1") }),
      SlotStateSchema.safeExtend({ id: z.literal("worker-2") }),
    ]),
    version: z.literal(1),
  })
  .strict()
  .superRefine((state, context) => {
    const addDuplicateIssue = (
      keys: readonly string[],
      path: readonly (string | number)[],
      message: string,
    ) => {
      if (new Set(keys).size !== keys.length) {
        context.addIssue({ code: "custom", message, path: [...path] });
      }
    };
    addDuplicateIssue(
      state.attempts.map((attempt) => attempt.attemptId),
      ["attempts"],
      "Attempt identifiers must be unique.",
    );
    addDuplicateIssue(
      state.deliveredEvents,
      ["deliveredEvents"],
      "Delivered event keys must be unique.",
    );
    addDuplicateIssue(
      state.audit.map((event) => JSON.stringify([event.eventId, event.attemptId])),
      ["audit"],
      "Attempt audit keys must be unique.",
    );
    addDuplicateIssue(
      state.maintenanceAudit.map((event) => event.eventId),
      ["maintenanceAudit"],
      "Maintenance event identifiers must be unique.",
    );
    addDuplicateIssue(
      state.reworkAudit.map((event) => event.eventId),
      ["reworkAudit"],
      "Rework audit event identifiers must be unique.",
    );
    addDuplicateIssue(
      state.reworkRequests.map((request) => request.eventId),
      ["reworkRequests"],
      "Rework request event identifiers must be unique.",
    );

    const activeAttempts = state.slots.flatMap((slot) =>
      slot.attemptId === undefined ? [] : [slot.attemptId],
    );
    if (new Set(activeAttempts).size !== activeAttempts.length) {
      context.addIssue({
        code: "custom",
        message: "An attempt cannot occupy both slots.",
        path: ["slots"],
      });
    }
    const activeIssues = state.attempts
      .filter((attempt) => activeAttempts.includes(attempt.attemptId))
      .map((attempt) => attempt.issueNumber);
    if (new Set(activeIssues).size !== activeIssues.length) {
      context.addIssue({
        code: "custom",
        message: "An issue cannot have more than one active attempt.",
        path: ["attempts"],
      });
    }
    const reservedStages = new Set<AttemptStage>(["reserved", "claimed", "launch-pending"]);
    const runningStages = new Set<AttemptStage>([
      "running",
      "prepared",
      "implemented",
      "committed",
      "verified",
      "pushed",
      "pr-linked",
    ]);
    const verifiedStages = new Set<AttemptStage>([
      "verified",
      "pushed",
      "pr-linked",
      "review",
      "completed",
    ]);
    for (const attempt of state.attempts) {
      const owners = state.slots.filter((slot) => slot.attemptId === attempt.attemptId);
      if (
        (reservedStages.has(attempt.stage) || runningStages.has(attempt.stage)) &&
        owners.length !== 1
      ) {
        context.addIssue({
          code: "custom",
          message: "Every non-terminal attempt must have exactly one slot owner.",
          path: ["attempts"],
        });
      }
      if (["review", "completed"].includes(attempt.stage) && owners.length !== 0) {
        context.addIssue({
          code: "custom",
          message: "Review and completed attempts cannot retain a slot.",
          path: ["attempts"],
        });
      }
      if (attempt.stage === "attention" && owners.some((slot) => slot.status !== "attention")) {
        context.addIssue({
          code: "custom",
          message: "An attention hold requires an attention slot.",
          path: ["attempts"],
        });
      }
      if (
        attempt.verification !== undefined &&
        (attempt.verification.attemptId !== attempt.attemptId ||
          attempt.verification.slotId !== attempt.slotId ||
          attempt.verification.commitSha !== attempt.commitSha)
      ) {
        context.addIssue({
          code: "custom",
          message: "Verification evidence must be bound to its exact attempt, slot, and commit.",
          path: ["attempts"],
        });
      }
      if (
        verifiedStages.has(attempt.stage) &&
        (attempt.commitSha === undefined ||
          attempt.verification?.status !== "pass" ||
          attempt.verification.attemptId !== attempt.attemptId ||
          attempt.verification.slotId !== attempt.slotId ||
          attempt.verification.commitSha !== attempt.commitSha)
      ) {
        context.addIssue({
          code: "custom",
          message: "Published stages require matching passing verification evidence.",
          path: ["attempts"],
        });
      }
      if (
        ["pr-linked", "review", "completed"].includes(attempt.stage) &&
        attempt.pullRequest === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "PR-linked stages require persisted pull request evidence.",
          path: ["attempts"],
        });
      }
    }
    for (const slot of state.slots) {
      if (slot.attemptId === undefined) continue;
      const matching = state.attempts.filter(
        (attempt) => attempt.attemptId === slot.attemptId && attempt.slotId === slot.id,
      );
      if (matching.length !== 1) {
        context.addIssue({
          code: "custom",
          message: "Every occupied slot must reference its own persisted attempt.",
          path: ["slots"],
        });
        continue;
      }
      const attempt = matching[0];
      if (attempt === undefined) continue;
      const expectedStatus = reservedStages.has(attempt.stage)
        ? "reserved"
        : runningStages.has(attempt.stage)
          ? "running"
          : attempt.stage === "attention"
            ? "attention"
            : undefined;
      if (expectedStatus === undefined || slot.status !== expectedStatus) {
        context.addIssue({
          code: "custom",
          message: "Slot status is incompatible with its attempt stage.",
          path: ["slots"],
        });
      }
      if (slot.leaseExpiresAt !== attempt.leaseExpiresAt) {
        context.addIssue({
          code: "custom",
          message: "Slot and attempt leases must match exactly.",
          path: ["slots"],
        });
      }
    }
  });

export type LoopState = z.infer<typeof LoopStateSchema>;

export const emptyLoopState = (): LoopState => ({
  attempts: [],
  audit: [],
  deliveredEvents: [],
  maintenanceAudit: [],
  reworkAudit: [],
  reworkRequests: [],
  slots: [
    { id: "worker-1", status: "free" },
    { id: "worker-2", status: "free" },
  ],
  version: 1,
});

export function deliveryKey(eventId: string, attemptId: string): string {
  const key = JSON.stringify([
    SafeIdentifierSchema.parse(eventId),
    SafeIdentifierSchema.parse(attemptId),
  ]);
  return DeliveryKeySchema.parse(key);
}

export function safeEventId(value: string): string {
  return SafeIdentifierSchema.parse(value);
}

export function safeErrorCode(value: string): string {
  return ErrorCodeSchema.parse(value);
}
