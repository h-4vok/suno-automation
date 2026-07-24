import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import {
  CommitShaSchema,
  GitHubLoginSchema,
  GitRefSchema,
  IssueCandidateSchema,
  LIFECYCLE_LABELS,
  TimestampSchema,
  type IssueCandidate,
  type LoopConfig,
} from "./schema.js";

const execFileAsync = promisify(execFile);

export interface IssueTransition {
  readonly attemptId: string;
  readonly comment: string;
  readonly eventId: string;
  readonly from: "codex-ready" | "codex-in-progress" | "codex-review" | "codex-rework";
  readonly issueNumber: number;
  readonly to: "codex-in-progress" | "codex-review" | "codex-rework" | "codex-needs-attention";
}

export const PullRequestSnapshotSchema = z
  .object({
    baseRef: GitRefSchema,
    draft: z.boolean(),
    headRef: GitRefSchema,
    headRepositoryOwner: GitHubLoginSchema,
    headSha: CommitShaSchema,
    isCrossRepository: z.boolean(),
    number: z.number().int().positive(),
    state: z.enum(["open", "closed", "merged"]),
    url: z.url(),
  })
  .strict();
export type PullRequestSnapshot = z.infer<typeof PullRequestSnapshotSchema>;

export interface ReworkEvidenceInput {
  readonly approvedFeedbackIds: readonly string[];
  readonly baseCommit: string;
  readonly eventId: string;
  readonly issueNumber: number;
  readonly prNumber: number;
}

export interface ReworkAuthorizationEvidence {
  readonly feedback: readonly {
    readonly createdAt: string;
    readonly id: string;
    readonly resolved: boolean;
  }[];
  readonly headCommitAt: string;
  readonly headSha: string;
  readonly requestActor: string;
  readonly requestedAt: string;
}

export interface ReconciliationAuthorizationInput {
  readonly action: string;
  readonly attemptId: string;
  readonly eventId: string;
  readonly issueNumber: number;
}

export interface EnsureDraftPullRequestInput {
  readonly attemptId: string;
  readonly baseRef: string;
  readonly body: string;
  readonly headRef: string;
  readonly expectedHeadSha: string;
  readonly issueNumber: number;
  readonly title: string;
}

export interface CompleteMergedIssueInput {
  readonly attemptId: string;
  readonly comment: string;
  readonly eventId: string;
  readonly from: "codex-in-progress" | "codex-review";
  readonly issueNumber: number;
}

export interface GitHubLoopPort {
  authenticatedLogin?(): Promise<string>;
  completeMergedIssue?(input: CompleteMergedIssueInput): Promise<"applied" | "duplicate">;
  ensureDraftPullRequest(input: EnsureDraftPullRequestInput): Promise<PullRequestSnapshot>;
  getIssue(issueNumber: number): Promise<IssueCandidate>;
  getPullRequest(number: number): Promise<PullRequestSnapshot>;
  getReconciliationAuthorization?(
    input: ReconciliationAuthorizationInput,
  ): Promise<{ readonly actor: string; readonly authorizedAt: string }>;
  getReworkAuthorization?(input: ReworkEvidenceInput): Promise<ReworkAuthorizationEvidence>;
  listQueue(): Promise<readonly IssueCandidate[]>;
  listTrackedIssues?(): Promise<readonly IssueCandidate[]>;
  transitionIssue(transition: IssueTransition): Promise<"applied" | "duplicate">;
}

export interface CommandResult {
  readonly stdout: string;
}

export interface GhCommandRunner {
  run(args: readonly string[]): Promise<CommandResult>;
}

export class GhCommandError extends Error {
  readonly safeCode: string;

  constructor(safeCode: string) {
    super(`GitHub command failed (${safeCode}).`);
    this.name = "GhCommandError";
    this.safeCode = safeCode;
  }
}

export class ExecFileGhRunner implements GhCommandRunner {
  async run(args: readonly string[]): Promise<CommandResult> {
    try {
      const result = await execFileAsync("gh", [...args], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
        windowsHide: true,
      });
      return { stdout: result.stdout };
    } catch {
      throw new GhCommandError("gh-command-failed");
    }
  }
}

interface GhIssue {
  readonly body: string;
  readonly comments?: readonly {
    readonly author?: { readonly login?: string };
    readonly body: string;
    readonly createdAt?: string;
  }[];
  readonly createdAt: string;
  readonly labels: readonly { readonly name: string }[];
  readonly number: number;
  readonly state: "OPEN" | "CLOSED";
  readonly title: string;
  readonly url: string;
}

const GraphQlPullRequestSchema = z
  .object({
    baseRefName: GitRefSchema,
    headRefName: GitRefSchema,
    headRefOid: CommitShaSchema,
    headRepositoryOwner: z.object({ login: GitHubLoginSchema }).strict().nullable().optional(),
    isDraft: z.boolean(),
    isCrossRepository: z.boolean().optional(),
    number: z.number().int().positive(),
    repository: z
      .object({ nameWithOwner: z.string().trim().min(3).max(202) })
      .strict()
      .optional(),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    url: z.url(),
  })
  .strict();
type GraphQlPullRequest = z.infer<typeof GraphQlPullRequestSchema>;

const LinkedPullRequestResponseSchema = z
  .object({
    data: z
      .object({
        repository: z
          .object({
            issue: z
              .object({
                timelineItems: z
                  .object({
                    nodes: z
                      .array(
                        z
                          .object({
                            source: GraphQlPullRequestSchema.nullable().optional(),
                          })
                          .strict(),
                      )
                      .readonly(),
                  })
                  .strict(),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const linkedPrQuery = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT]){
        nodes{... on CrossReferencedEvent{source{... on PullRequest{
          number url state isDraft baseRefName headRefName isCrossRepository
          headRefOid headRepositoryOwner{login} repository{nameWithOwner}
        }}}}
      }
    }
  }
}`;

const reworkEvidenceQuery = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number state isDraft headRefOid
      commits(last:1){nodes{commit{oid committedDate}}}
      reviewThreads(first:100){
        nodes{id isResolved comments(first:100){nodes{id createdAt}}}
      }
    }
  }
}`;

function dependencyNumbers(body: string): readonly number[] {
  const found = new Set<number>();
  for (const line of body.split(/\r?\n/)) {
    if (!/\bblocked by\b/i.test(line)) continue;
    for (const match of line.matchAll(/#(\d+)/g)) found.add(Number(match[1]));
  }
  return [...found].sort((left, right) => left - right);
}

function normalizePullRequest(value: unknown): PullRequestSnapshot {
  const pr = GraphQlPullRequestSchema.parse(value);
  return PullRequestSnapshotSchema.parse({
    baseRef: pr.baseRefName,
    draft: pr.isDraft,
    headRef: pr.headRefName,
    headRepositoryOwner: pr.headRepositoryOwner?.login ?? "",
    headSha: pr.headRefOid,
    isCrossRepository: pr.isCrossRepository ?? true,
    number: pr.number,
    state: pr.state.toLowerCase(),
    url: pr.url,
  });
}

function parseJson(value: string, safeCode: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new GhCommandError(safeCode);
  }
}

function promotionEvidence(comments: GhIssue["comments"]): IssueCandidate["promotion"] {
  const matches =
    comments?.filter(
      (comment) =>
        comment.body.trim() ===
        "codex-lifecycle event=contract-promoted from=backlog to=codex-ready",
    ) ?? [];
  if (matches.length !== 1) return undefined;
  const actor = matches[0]?.author?.login;
  return actor === undefined
    ? undefined
    : {
        actor,
        eventId: "contract-promoted",
      };
}

export class GhCliLoopAdapter implements GitHubLoopPort {
  readonly #config: LoopConfig;
  readonly #repository: string;
  readonly #runner: GhCommandRunner;

  constructor(config: LoopConfig, runner: GhCommandRunner = new ExecFileGhRunner()) {
    this.#config = config;
    this.#repository = `${config.repository.owner}/${config.repository.name}`;
    this.#runner = runner;
  }

  async listQueue(): Promise<readonly IssueCandidate[]> {
    return (await this.listTrackedIssues()).filter((issue) =>
      issue.labels.some((label) => ["codex-ready", "codex-rework"].includes(label)),
    );
  }

  async authenticatedLogin(): Promise<string> {
    const response = await this.#runner.run(["api", "user", "--jq", ".login"]);
    const login = response.stdout.trim();
    if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login)) {
      throw new GhCommandError("authenticated-login-invalid");
    }
    return login;
  }

  async listTrackedIssues(): Promise<readonly IssueCandidate[]> {
    const response = await this.#runner.run([
      "issue",
      "list",
      "--repo",
      this.#repository,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,body,state,labels,createdAt,url,comments",
    ]);
    const issues = parseJson(response.stdout, "invalid-issue-list") as readonly GhIssue[];
    const tracked = issues.filter((issue) =>
      issue.labels.some((label) => (LIFECYCLE_LABELS as readonly string[]).includes(label.name)),
    );
    return Promise.all(tracked.map(async (issue) => this.#hydrateIssue(issue)));
  }

  async getIssue(issueNumber: number): Promise<IssueCandidate> {
    const response = await this.#runner.run([
      "issue",
      "view",
      issueNumber.toString(),
      "--repo",
      this.#repository,
      "--json",
      "number,title,body,state,labels,createdAt,url,comments",
    ]);
    return this.#hydrateIssue(parseJson(response.stdout, "invalid-issue") as GhIssue);
  }

  async transitionIssue(transition: IssueTransition): Promise<"applied" | "duplicate"> {
    const response = await this.#runner.run([
      "issue",
      "view",
      transition.issueNumber.toString(),
      "--repo",
      this.#repository,
      "--json",
      "labels,comments",
    ]);
    const current = parseJson(response.stdout, "invalid-transition-state") as GhIssue;
    const labels = current.labels.map((label) => label.name);
    const lifecycles = labels.filter((label) =>
      (LIFECYCLE_LABELS as readonly string[]).includes(label),
    );
    const commentDelivered =
      current.comments?.some((comment) => comment.body.trim() === transition.comment) ?? false;
    if (lifecycles.length === 1 && lifecycles[0] === transition.to) {
      // A target label by itself is not proof that *this* executor performed the
      // transition.  It can be an operator edit or a different attempt.  Adding our
      // marker at this point would forge idempotency evidence and could let a second
      // worker proceed after a foreign lifecycle change.
      if (!commentDelivered) throw new GhCommandError("lifecycle-delivery-ambiguous");
      return "duplicate";
    }
    if (lifecycles.length !== 1 || lifecycles[0] !== transition.from) {
      throw new GhCommandError("lifecycle-conflict");
    }

    await this.#runner.run([
      "issue",
      "edit",
      transition.issueNumber.toString(),
      "--repo",
      this.#repository,
      "--remove-label",
      transition.from,
      "--add-label",
      transition.to,
    ]);
    if (!commentDelivered) await this.#addComment(transition.issueNumber, transition.comment);
    return "applied";
  }

  async completeMergedIssue(input: CompleteMergedIssueInput): Promise<"applied" | "duplicate"> {
    const response = await this.#runner.run([
      "issue",
      "view",
      input.issueNumber.toString(),
      "--repo",
      this.#repository,
      "--json",
      "state,labels,comments",
    ]);
    const current = parseJson(response.stdout, "invalid-merge-completion-state") as GhIssue;
    if (current.state !== "CLOSED") throw new GhCommandError("merged-issue-not-closed");
    const lifecycles = current.labels
      .map((label) => label.name)
      .filter((label) => (LIFECYCLE_LABELS as readonly string[]).includes(label));
    const commentDelivered =
      current.comments?.some((comment) => comment.body.trim() === input.comment) ?? false;
    if (lifecycles.length === 0) {
      if (!commentDelivered) await this.#addComment(input.issueNumber, input.comment);
      return "duplicate";
    }
    if (lifecycles.length !== 1 || lifecycles[0] !== input.from) {
      throw new GhCommandError("lifecycle-conflict");
    }
    await this.#runner.run([
      "issue",
      "edit",
      input.issueNumber.toString(),
      "--repo",
      this.#repository,
      "--remove-label",
      input.from,
    ]);
    if (!commentDelivered) await this.#addComment(input.issueNumber, input.comment);
    return "applied";
  }

  async getPullRequest(number: number): Promise<PullRequestSnapshot> {
    const response = await this.#runner.run([
      "pr",
      "view",
      number.toString(),
      "--repo",
      this.#repository,
      "--json",
      "number,url,state,isDraft,baseRefName,headRefName,headRefOid,headRepositoryOwner,isCrossRepository",
    ]);
    return normalizePullRequest(parseJson(response.stdout, "invalid-pull-request"));
  }

  async getReconciliationAuthorization(
    input: ReconciliationAuthorizationInput,
  ): Promise<{ readonly actor: string; readonly authorizedAt: string }> {
    const response = await this.#runner.run([
      "issue",
      "view",
      input.issueNumber.toString(),
      "--repo",
      this.#repository,
      "--json",
      "comments",
    ]);
    const issue = parseJson(response.stdout, "invalid-reconciliation-authorization") as GhIssue;
    const marker = `codex-reconcile event=${input.eventId} attempt=${input.attemptId} action=${input.action}`;
    const matches = issue.comments?.filter((comment) => comment.body.trim() === marker) ?? [];
    if (matches.length !== 1) {
      throw new GhCommandError(
        matches.length === 0
          ? "reconciliation-authorization-missing"
          : "reconciliation-authorization-ambiguous",
      );
    }
    const actor = matches[0]?.author?.login;
    const authorizedAt = matches[0]?.createdAt;
    if (
      actor === undefined ||
      authorizedAt === undefined ||
      !GitHubLoginSchema.safeParse(actor).success ||
      !TimestampSchema.safeParse(authorizedAt).success
    ) {
      throw new GhCommandError("reconciliation-authorization-author-missing");
    }
    return { actor, authorizedAt };
  }

  async getReworkAuthorization(input: ReworkEvidenceInput): Promise<ReworkAuthorizationEvidence> {
    const issueResponse = await this.#runner.run([
      "issue",
      "view",
      input.issueNumber.toString(),
      "--repo",
      this.#repository,
      "--json",
      "comments",
    ]);
    const issue = parseJson(issueResponse.stdout, "invalid-rework-request") as GhIssue;
    const feedbackToken = input.approvedFeedbackIds.join(",");
    const marker = `codex-rework event=${input.eventId} pr=${input.prNumber.toString()} base=${input.baseCommit} feedback=${feedbackToken}`;
    const matchingRequests =
      issue.comments?.filter((comment) => comment.body.trim() === marker) ?? [];
    if (matchingRequests.length !== 1) {
      throw new GhCommandError(
        matchingRequests.length === 0 ? "rework-request-missing" : "rework-request-ambiguous",
      );
    }
    const request = matchingRequests[0];
    const requestActor = request?.author?.login;
    const requestedAt = request?.createdAt;
    if (
      requestActor === undefined ||
      requestedAt === undefined ||
      !GitHubLoginSchema.safeParse(requestActor).success ||
      !TimestampSchema.safeParse(requestedAt).success
    ) {
      throw new GhCommandError("rework-request-author-missing");
    }

    const response = await this.#runner.run([
      "api",
      "graphql",
      "-f",
      `query=${reworkEvidenceQuery}`,
      "-f",
      `owner=${this.#config.repository.owner}`,
      "-f",
      `name=${this.#config.repository.name}`,
      "-F",
      `number=${input.prNumber.toString()}`,
    ]);
    const value = parseJson(response.stdout, "invalid-rework-evidence") as {
      readonly data?: {
        readonly repository?: {
          readonly pullRequest?: {
            readonly commits?: {
              readonly nodes?: readonly {
                readonly commit?: { readonly committedDate?: string; readonly oid?: string };
              }[];
            };
            readonly headRefOid?: string;
            readonly isDraft?: boolean;
            readonly reviewThreads?: {
              readonly nodes?: readonly {
                readonly comments?: {
                  readonly nodes?: readonly {
                    readonly createdAt?: string;
                    readonly id?: string;
                  }[];
                };
                readonly id?: string;
                readonly isResolved?: boolean;
              }[];
            };
            readonly state?: "OPEN" | "CLOSED" | "MERGED";
          };
        };
      };
    };
    const pullRequest = value.data?.repository?.pullRequest;
    const headCommit = pullRequest?.commits?.nodes?.[0]?.commit;
    if (
      pullRequest?.state !== "OPEN" ||
      pullRequest.isDraft !== true ||
      pullRequest.headRefOid === undefined ||
      headCommit?.oid === undefined ||
      headCommit.committedDate === undefined ||
      pullRequest.headRefOid !== headCommit.oid ||
      !CommitShaSchema.safeParse(pullRequest.headRefOid).success ||
      !CommitShaSchema.safeParse(headCommit.oid).success ||
      !TimestampSchema.safeParse(headCommit.committedDate).success
    ) {
      throw new GhCommandError("rework-pull-request-evidence-conflict");
    }
    const feedback = input.approvedFeedbackIds.map((id) => {
      const matches =
        pullRequest.reviewThreads?.nodes?.filter(
          (thread) =>
            thread.id === id ||
            thread.comments?.nodes?.some((comment) => comment.id === id) === true,
        ) ?? [];
      if (matches.length !== 1) throw new GhCommandError("rework-feedback-ambiguous");
      const thread = matches[0];
      const createdAt = thread?.comments?.nodes?.[0]?.createdAt;
      if (
        thread?.id === undefined ||
        createdAt === undefined ||
        thread.isResolved === undefined ||
        !TimestampSchema.safeParse(createdAt).success
      ) {
        throw new GhCommandError("rework-feedback-evidence-missing");
      }
      return { createdAt, id, resolved: thread.isResolved };
    });
    return {
      feedback,
      headCommitAt: headCommit.committedDate,
      headSha: pullRequest.headRefOid,
      requestActor,
      requestedAt,
    };
  }

  async ensureDraftPullRequest(input: EnsureDraftPullRequestInput): Promise<PullRequestSnapshot> {
    const existing = await this.#findPullRequestByHead(input.headRef);
    if (existing !== undefined) {
      if (
        !existing.draft ||
        existing.state !== "open" ||
        existing.baseRef !== input.baseRef ||
        existing.isCrossRepository ||
        existing.headRepositoryOwner.toLowerCase() !==
          this.#config.repository.owner.toLowerCase() ||
        existing.headSha !== input.expectedHeadSha
      ) {
        throw new GhCommandError("conflicting-pull-request");
      }
      return existing;
    }

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "codex-loop-pr-"));
    const bodyPath = join(temporaryDirectory, "body.md");
    let creationFailed = false;
    try {
      await writeFile(bodyPath, input.body, { encoding: "utf8", mode: 0o600 });
      try {
        await this.#runner.run([
          "pr",
          "create",
          "--repo",
          this.#repository,
          "--draft",
          "--base",
          input.baseRef,
          "--head",
          input.headRef,
          "--title",
          input.title,
          "--body-file",
          bodyPath,
        ]);
      } catch {
        creationFailed = true;
      }
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
    const created = await this.#findPullRequestByHead(input.headRef);
    if (
      !created?.draft ||
      created.state !== "open" ||
      created.baseRef !== input.baseRef ||
      created.isCrossRepository ||
      created.headRepositoryOwner.toLowerCase() !== this.#config.repository.owner.toLowerCase() ||
      created.headSha !== input.expectedHeadSha
    ) {
      throw new GhCommandError(
        creationFailed ? "pull-request-create-ambiguous" : "pull-request-acknowledgement-missing",
      );
    }
    return created;
  }

  async #hydrateIssue(issue: GhIssue): Promise<IssueCandidate> {
    const dependencyStates = await Promise.all(
      dependencyNumbers(issue.body).map(async (number) => ({
        number,
        state: await this.#dependencyState(number),
      })),
    );
    const linkedPullRequest = await this.#linkedPullRequest(issue.number);
    const promotion = promotionEvidence(issue.comments);
    return IssueCandidateSchema.parse({
      createdAt: issue.createdAt,
      dependencies: dependencyStates,
      labels: issue.labels.map((label) => label.name),
      ...(linkedPullRequest === undefined ? {} : { linkedPullRequest }),
      number: issue.number,
      ...(promotion === undefined ? {} : { promotion }),
      state: issue.state.toLowerCase(),
      title: issue.title,
      url: issue.url,
    });
  }

  async #dependencyState(number: number): Promise<"open" | "closed" | "unknown"> {
    try {
      const response = await this.#runner.run([
        "issue",
        "view",
        number.toString(),
        "--repo",
        this.#repository,
        "--json",
        "state",
      ]);
      const value = parseJson(response.stdout, "invalid-dependency") as {
        readonly state: "OPEN" | "CLOSED";
      };
      return value.state.toLowerCase() as "open" | "closed";
    } catch {
      return "unknown";
    }
  }

  async #linkedPullRequest(issueNumber: number): Promise<PullRequestSnapshot | undefined> {
    const response = await this.#runner.run([
      "api",
      "graphql",
      "-f",
      `query=${linkedPrQuery}`,
      "-f",
      `owner=${this.#config.repository.owner}`,
      "-f",
      `name=${this.#config.repository.name}`,
      "-F",
      `number=${issueNumber.toString()}`,
    ]);
    let graph: z.infer<typeof LinkedPullRequestResponseSchema>;
    try {
      graph = LinkedPullRequestResponseSchema.parse(
        parseJson(response.stdout, "invalid-linked-pull-request"),
      );
    } catch (error) {
      if (error instanceof GhCommandError) throw error;
      throw new GhCommandError("invalid-linked-pull-request");
    }
    const prs = graph.data.repository.issue.timelineItems.nodes
      .flatMap((node) => {
        if (node.source === undefined || node.source === null) return [];
        if (node.source.repository === undefined) {
          throw new GhCommandError("invalid-linked-pull-request");
        }
        if (node.source.repository.nameWithOwner.toLowerCase() !== this.#repository.toLowerCase())
          return [];
        return [node.source];
      })
      .map(normalizePullRequest);
    const byNumber = new Map<number, PullRequestSnapshot>();
    for (const pr of prs) {
      const existing = byNumber.get(pr.number);
      if (
        existing !== undefined &&
        (existing.baseRef !== pr.baseRef ||
          existing.headRef !== pr.headRef ||
          existing.headSha !== pr.headSha ||
          existing.headRepositoryOwner !== pr.headRepositoryOwner ||
          existing.isCrossRepository !== pr.isCrossRepository ||
          existing.draft !== pr.draft ||
          existing.state !== pr.state ||
          existing.url !== pr.url)
      ) {
        throw new GhCommandError("linked-pull-request-evidence-conflict");
      }
      byNumber.set(pr.number, pr);
    }
    const linked = [...byNumber.values()];
    if (linked.length > 1) throw new GhCommandError("multiple-linked-pull-requests");
    return linked[0];
  }

  async #findPullRequestByHead(headRef: string): Promise<PullRequestSnapshot | undefined> {
    const response = await this.#runner.run([
      "pr",
      "list",
      "--repo",
      this.#repository,
      "--state",
      "all",
      "--head",
      headRef,
      "--limit",
      "2",
      "--json",
      "number,url,state,isDraft,baseRefName,headRefName,headRefOid,headRepositoryOwner,isCrossRepository",
    ]);
    const values = (
      parseJson(response.stdout, "invalid-pull-request-list") as readonly GraphQlPullRequest[]
    ).map(normalizePullRequest);
    if (values.length > 1) throw new GhCommandError("multiple-branch-pull-requests");
    return values[0];
  }

  async #addComment(issueNumber: number, body: string): Promise<void> {
    await this.#runner.run([
      "issue",
      "comment",
      issueNumber.toString(),
      "--repo",
      this.#repository,
      "--body",
      body,
    ]);
  }
}
