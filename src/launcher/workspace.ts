#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { cutoverPending, workspaceContext } from "../lib/slipjay.ts";
import { legacyStateHome } from "../lib/workspace/workspace-paths.ts";
import { runStatus, runLanded, runMode, runList, runPool, runAttachIssue, runAdopt } from "./workspace-commands.ts";
import { runPrune, runEvict, runArchive, runRestore, runArchives, runMaintain, runRetire, runRetireResult, runRetirements, runCleanup, runRemove } from "./retention-commands.ts";
import { runStart, runAttempt } from "./start-commands.ts";
import { runPreview, runRepair, runLand } from "./landing-commands.ts";
import { runRelease, runPromote, runDeploy, runReset, runAudit, runDeploys } from "./release-commands.ts";
import { runConfig, runPolicy } from "./policy-commands.ts";
import { runCutover } from "./cutover-command.ts";
import { runMetrics, runRecordPreview, runWatch, runCancel } from "./observation-commands.ts";
import { runRunner } from "./runner-command.ts";
import { runGuard } from "./hook-command.ts";

const handlers: Record<string, (args: string[]) => Promise<number | void>> = {
  "status": runStatus,
  "landed": runLanded,
  "mode": runMode,
  "list": runList,
  "pool": runPool,
  "attach-issue": runAttachIssue,
  "adopt": runAdopt,
  "prune": runPrune,
  "evict": runEvict,
  "archive": runArchive,
  "restore": runRestore,
  "archives": runArchives,
  "maintain": runMaintain,
  "retire": runRetire,
  "retire-result": runRetireResult,
  "retirements": runRetirements,
  "cleanup": runCleanup,
  "remove": runRemove,
  "start": runStart,
  "attempt": runAttempt,
  "preview": runPreview,
  "repair": runRepair,
  "land": runLand,
  "release": runRelease,
  "promote": runPromote,
  "deploy": runDeploy,
  "reset": runReset,
  "audit": runAudit,
  "deploys": runDeploys,
  "config": runConfig,
  "policy": runPolicy,
  "cutover": runCutover,
  "metrics": runMetrics,
  "record-preview": runRecordPreview,
  "watch": runWatch,
  "cancel": runCancel,
  "runner": runRunner,
  "guard": runGuard,
};

const [command, ...rest] = process.argv.slice(2);

try {
  if (command !== "status" && command !== "cutover" && command !== "--version" && cutoverPending()) {
    // Before the cutover, only `status` and `cutover` run: anything else would start a second lock store.
    console.error(`slipjay ${command ?? ""}`.trim() + ` refused: this machine's slipjay state still lives under ${legacyStateHome()}. `
      + "Run `slipjay cutover` once while nothing is landing (`slipjay cutover --check` reports what holds it), then retry.");
    process.exitCode = 1;
  } else if (command === "--version") {
    console.log(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
  } else if (command === "status" && cutoverPending()) {
    const context = await workspaceContext();
    console.log(JSON.stringify({
      cutover: { required: true, legacyState: legacyStateHome(), command: "slipjay cutover" },
      ...(context ? { workspace: context.current, integration: context.integration, integrationBranch: context.integrationBranch } : {}),
    }, null, 2));
  } else if (command && Object.hasOwn(handlers, command)) {
    const code = await handlers[command]!(rest);
    if (code !== undefined) process.exitCode = code;
  } else {
    console.error("Usage: slipjay <--version|status|config|policy <show|set>|mode|list|pool [refill]|prune --empty|prune [--empty] --plan [--json]|attach-issue|start|attempt <show|release> <id>|repair <failed-operation> [--json]|preview|land|promote [--candidate <commit>] [--confirm <commit>] [--migrations-ready]|deploy <environment>|deploys [--environment <name>] [--json]|reset|audit [status|cause <landing...|--flake|--infrastructure|--unresolved>]|metrics [--since <ISO date>] [--repo <owner/name>] [--json]|record-preview <port>|watch --json|cancel <id>|adopt <path> [--json]|cleanup [path]|evict [--plan] [--json] [--idle-hours <n>]|archive [path]|restore <archive-id> [--name <n>] [--path <p>]|restore --latest --path <p>|archives|maintain [--json]|retire <path> --operation <id>|retire-result <operation-id> | retire-result --path <path>|retirements|remove [--discard] <path>|cutover [--check]|runner <serve|log <operation>|outcome <operation>|handoff <operation>|source <operation> <bundle-file>|repair-claim <operation>|repair-release <operation>|repair-revoke <operation>|artifact <operation> <run>|kill [<operation>]|pause|resume|release <owner/repo>>>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
