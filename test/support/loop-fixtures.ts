import {
  IssueCandidateSchema,
  LoopConfigSchema,
  emptyLoopState,
  type IssueCandidate,
  type LoopConfig,
  type LoopState,
} from "../../src/loop/schema.js";
import {
  DispatcherCapabilityEvidenceSchema,
  type DispatcherCapabilityEvidence,
} from "../../src/loop/policy.js";

export const loopNow = "2026-07-23T12:00:00.000Z";

export function loopConfig(): LoopConfig {
  return LoopConfigSchema.parse({
    dispatcher: { leaseSeconds: 7_200, mutexSeconds: 60, pollMinutes: 15 },
    repository: { baseBranch: "main", name: "suno-automation", owner: "owner" },
    retention: { completedAttempts: 500, days: 90 },
    slots: [
      {
        id: "worker-1",
        projectId: "project-worker-1",
        worktreePath: "C:\\safe\\worker-1",
      },
      {
        id: "worker-2",
        projectId: "project-worker-2",
        worktreePath: "C:\\safe\\worker-2",
      },
    ],
    stateDirectory: "C:\\safe\\state",
    trustedLogins: ["owner"],
    verificationKeyEnv: "CODEX_LOOP_VERIFICATION_KEY",
    version: 1,
  });
}

export function loopCapabilities(): DispatcherCapabilityEvidence {
  const config = loopConfig();
  return DispatcherCapabilityEvidenceSchema.parse({
    observedAt: loopNow,
    projects: config.slots.map((slot) => ({
      available: true,
      projectId: slot.projectId,
      slotId: slot.id,
    })),
    source: "codex-desktop",
    threadControl: true,
    version: 1,
  });
}

export function issueCandidate(
  number: number,
  overrides: Partial<IssueCandidate> = {},
): IssueCandidate {
  return IssueCandidateSchema.parse({
    author: "owner",
    createdAt: new Date(Date.parse(loopNow) + number * 1_000).toISOString(),
    dependencies: [],
    labels: ["enhancement", "codex-ready", "priority:p1"],
    number,
    promotion: {
      actor: "owner",
      eventId: "contract-promoted",
    },
    state: "open",
    title: `Safe issue ${number.toString()}`,
    url: `https://github.com/owner/suno-automation/issues/${number.toString()}`,
    ...overrides,
  });
}

export function loopState(): LoopState {
  return emptyLoopState();
}

export function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fixture value is missing.");
  return value;
}
