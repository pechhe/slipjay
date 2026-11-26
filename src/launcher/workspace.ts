#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { cutoverPending, legacyStateHome } from "../lib/workspace/workspace-paths.ts";

// Dynamic imports keep CLI startup proportional to the invoked command rather than loading every capability.
const handlers: Record<string, (args: string[]) => Promise<number | void>> = {
  "status": () => import("./workspace-commands.ts").then((m) => m.runStatus()),
  "landed": (args) => import("./workspace-commands.ts").then((m) => m.runLanded(args)),
  "mode": (args) => import("./workspace-commands.ts").then((m) => m.runMode(args)),
  "list": () => import("./workspace-commands.ts").then((m) => m.runList()),
  "pool": (args) => import("./workspace-commands.ts").then((m) => m.runPool(args)),
  "attach-issue": (args) => import("./workspace-commands.ts").then((m) => m.runAttachIssue(args)),
  "attach-project": (args) => import("./workspace-commands.ts").then((m) => m.runAttachProject(args)),
  "adopt": (args) => import("./workspace-commands.ts").then((m) => m.runAdopt(args)),
  "prune": (args) => import("./retention-commands.ts").then((m) => m.runPrune(args)),
  "evict": (args) => import("./retention-commands.ts").then((m) => m.runEvict(args)),
  "disk": (args) => import("./disk-command.ts").then((m) => m.runDisk(args)),
  "archive": (args) => import("./retention-commands.ts").then((m) => m.runArchive(args)),
  "restore": (args) => import("./retention-commands.ts").then((m) => m.runRestore(args)),
  "archives": (args) => import("./retention-commands.ts").then((m) => m.runArchives(args)),
  "maintain": (args) => import("./retention-commands.ts").then((m) => m.runMaintain(args)),
  "retire": (args) => import("./retention-commands.ts").then((m) => m.runRetire(args)),
  "retire-result": (args) => import("./retention-commands.ts").then((m) => m.runRetireResult(args)),
  "retirements": (args) => import("./retention-commands.ts").then((m) => m.runRetirements(args)),
  "cleanup": (args) => import("./retention-commands.ts").then((m) => m.runCleanup(args)),
  "remove": (args) => import("./retention-commands.ts").then((m) => m.runRemove(args)),
  "claims": (args) => import("./claim-commands.ts").then((m) => m.runClaims(args)),
  "start": (args) => import("./start-commands.ts").then((m) => m.runStart(args)),
  "attempt": (args) => import("./start-commands.ts").then((m) => m.runAttempt(args)),
  "preview": () => import("./landing-commands.ts").then((m) => m.runPreview()),
  "repair": (args) => import("./landing-commands.ts").then((m) => m.runRepair(args)),
  "land": (args) => import("./landing-commands.ts").then((m) => m.runLand(args)),
  "release": () => import("./release-commands.ts").then((m) => m.runRelease()),
  "promote": (args) => import("./release-commands.ts").then((m) => m.runPromote(args)),
  "deploy": (args) => import("./release-commands.ts").then((m) => m.runDeploy(args)),
  "reset": (args) => import("./release-commands.ts").then((m) => m.runReset(args)),
  "audit": (args) => import("./release-commands.ts").then((m) => m.runAudit(args)),
  "deploys": (args) => import("./release-commands.ts").then((m) => m.runDeploys(args)),
  "config": (args) => import("./policy-commands.ts").then((m) => m.runConfig(args)),
  "upgrade": (args) => import("./upgrade-command.ts").then((m) => m.runUpgrade(args)),
  "changes": (args) => import("./upgrade-command.ts").then((m) => m.runChanges(args)),
  "policy": (args) => import("./policy-commands.ts").then((m) => m.runPolicy(args)),
  "cutover": (args) => import("./cutover-command.ts").then((m) => m.runCutover(args)),
  "metrics": (args) => import("./observation-commands.ts").then((m) => m.runMetrics(args)),
  "record-preview": (args) => import("./observation-commands.ts").then((m) => m.runRecordPreview(args)),
  "watch": (args) => import("./observation-commands.ts").then((m) => m.runWatch(args)),
  "cancel": (args) => import("./observation-commands.ts").then((m) => m.runCancel(args)),
  "runner": (args) => import("./runner-command.ts").then((m) => m.runRunner(args)),
  "guard": () => import("./hook-command.ts").then((m) => m.runGuard()),
  "host-budget": (args) => import("./host-budget-command.ts").then((m) => m.runHostBudget(args)),
};

const [command, ...rest] = process.argv.slice(2);

try {
  if (command !== "status" && command !== "cutover" && command !== "--version" && cutoverPending()) {
    // Before the cutover, only `status` and `cutover` run: anything else would start a second lock store.
    console.error(`slipjay ${command ?? ""}`.trim() + ` refused: this machine's slipjay state still lives under ${legacyStateHome()}. `
      + "Run `slipjay cutover` once while nothing is landing (`slipjay cutover --check` reports what holds it), then retry.");
    process.exitCode = 1;
  } else if (command === "--version") {
    const { describeInstall } = await import("../lib/workspace/workspace-upgrade.ts");
    console.log(describeInstall(fileURLToPath(new URL("../..", import.meta.url))));
  } else if (command === "status" && cutoverPending()) {
    const { workspaceContext } = await import("../lib/infra/workspace-jj.ts");
    const context = await workspaceContext();
    console.log(JSON.stringify({
      cutover: { required: true, legacyState: legacyStateHome(), command: "slipjay cutover" },
      ...(context ? { workspace: context.current, integration: context.integration, integrationBranch: context.integrationBranch } : {}),
    }, null, 2));
  } else if (command && Object.hasOwn(handlers, command)) {
    const invoke = () => handlers[command]!(rest);
    const code = command === "cutover" ? await invoke() : await (await import("../lib/workspace/workspace-claim-activation.ts")).withManagedCleanupWorker(invoke);
    if (code !== undefined) process.exitCode = code;
  } else {
    console.error("Usage: slipjay <--version|status|claims <capability|activate|controller|acquire|release|transfer|recover|status>|host-budget wait|waits|config|upgrade [--runner] [--rollback] [--json]|changes [--since <revision|YYYY-MM-DD>] [--json]|policy <show|set>|mode|list|pool [refill]|prune --empty|prune [--empty] --plan [--json]|attach-issue|attach-project|start [--claim-stdin]|attempt <show|release> <id>|repair <failed-operation> [--json]|preview|land|promote [--candidate <commit>] [--confirm <commit>] [--migrations-ready]|deploy <environment>|deploys [--environment <name>] [--json]|reset|audit [status|cause <landing...|--flake|--infrastructure|--unresolved> --note <why> [--audit <id>] [--replace]]|metrics [--since <ISO date>] [--repo <owner/name>] [--json]|record-preview <port>|watch --json|cancel <id>|adopt <path> [--json]|cleanup [path]|evict [--plan] [--json] [--idle-hours <n>]|disk [--plan] [--json]|archive [path]|restore <archive-id> [--name <n>] [--path <p>]|restore --latest --path <p>|archives|maintain [--json]|retire <path> --operation <id>|retire-result <operation-id> | retire-result --path <path>|retirements|remove [--discard] <path>|cutover [--check]|runner <serve|log <operation>|outcome <operation>|handoff <operation>|source <operation> <bundle-file>|repair-claim <operation>|repair-release <operation>|repair-revoke <operation>|artifact <operation> <run>|kill [<operation>]|pause|resume|prioritize <operationId> [--while-paused] [--reason <text>] [--json]|release <owner/repo>>>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
