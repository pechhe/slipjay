import { runnerLocation } from "../lib/runner/runner-client.ts";
import { workspaceContext, spareAllowance } from "../lib/slipjay.ts";
import { machineConfigPath } from "../lib/workspace/workspace-paths.ts";
import { checkoutIdentity, machineSpareLimit, machineSpareLimits, readMachineConfig, runnerSetting, setConfiguredRunner, setMachineSpareLimit } from "../lib/policy/machine-config.ts";
import { setPolicy, showPolicy } from "../lib/policy/policy-command.ts";
import { retiredFieldsWarning } from "../lib/policy/execution-policy.ts";
import { resolve } from "node:path";
import { integrationRoot } from "./command-context.ts";

const CONFIG_USAGE = "Usage: slipjay config [--json] | config set runner <location> | config set spares <0-8> [--repo <integration checkout>] | config unset <runner|spares> [--repo <integration checkout>]";

/** `config`: this machine's runner location and spare limits, each with where it comes from. */
export async function runConfig(args: string[]): Promise<number> {
  const [action, key, ...more] = args;
  if (!action || action === "--json") {
    if (args.length > 1) throw new Error(CONFIG_USAGE);
    const config = readMachineConfig();
    const runner = runnerSetting(process.env, config);
    const context = await workspaceContext().catch(() => null);
    const roots = [...new Set([...context ? [checkoutIdentity(context.integration.root)] : [], ...Object.keys(machineSpareLimits(config)).map(checkoutIdentity)])];
    const spares = await Promise.all(roots.map(async (repository) => {
      const repositoryContext = await workspaceContext(repository).catch(() => null);
      const allowance = repositoryContext ? await spareAllowance(repositoryContext) : null;
      return { repository, declared: allowance?.declared ?? null, machineLimit: machineSpareLimit(repository, config), effective: allowance?.spares ?? null, source: allowance?.source ?? null };
    }));
    if (action === "--json") console.log(JSON.stringify({ path: machineConfigPath(), runner, spares }, null, 2));
    else {
      console.log(`runner: ${runner.value ?? "(none)"} (${runner.source === "environment" ? `from SLIPJAY_RUNNER${runner.overriddenByEnvironment ? `, overriding ${runner.file}` : ""}` : runner.source === "file" ? machineConfigPath() : "unset"})`);
      for (const entry of spares) {
        const declaredAt = entry.source ? ` on ${entry.source.integrationBranch}${entry.source.commitId ? ` at ${entry.source.commitId.slice(0, 12)}` : ""}` : "";
        console.log(`spares: ${entry.repository}: ${entry.effective ?? "?"} (declared ${entry.declared ?? "?"}${declaredAt}, machine limit ${entry.machineLimit ?? "none"})`);
      }
    }
    return 0;
  }
  if (action !== "set" && action !== "unset") throw new Error(CONFIG_USAGE);
  const repoIndex = more.indexOf("--repo");
  const repoPath = repoIndex >= 0 ? more[repoIndex + 1] : undefined;
  if (repoIndex >= 0 && (!repoPath || repoPath.startsWith("-"))) throw new Error(CONFIG_USAGE);
  const values = repoIndex >= 0 ? more.filter((_, index) => index !== repoIndex && index !== repoIndex + 1) : more;
  if (key === "runner" && repoIndex < 0 && values.length === (action === "set" ? 1 : 0)) {
    await setConfiguredRunner(action === "set" ? values[0]! : null);
    const runner = runnerSetting();
    console.log(JSON.stringify({ runner }));
    if (runner.overriddenByEnvironment) console.error(`SLIPJAY_RUNNER overrides this setting in the current environment (${runner.value})`);
    return 0;
  }
  if (key === "spares" && values.length === (action === "set" ? 1 : 0)) {
    const count = action === "set" ? Number(values[0]) : null;
    if (count !== null && !Number.isInteger(count)) throw new Error(CONFIG_USAGE);
    const root = await integrationRoot(repoPath ? resolve(repoPath) : process.cwd());
    await setMachineSpareLimit(root, count);
    const context = await workspaceContext(root);
    const allowance = context ? await spareAllowance(context) : null;
    console.log(JSON.stringify({ repository: root, declared: allowance?.declared ?? null, machineLimit: allowance?.machineLimit ?? null, effective: allowance?.spares ?? null, source: allowance?.source ?? null }));
    return 0;
  }
  throw new Error(CONFIG_USAGE);
}

const POLICY_USAGE = "Usage: slipjay policy show [--json] | policy set --base <revision> [--patch <json>] [--spares <0-8|default>] [--process <standard|light|development|default>] [--landing-verification <json list|default>] [--json-lines]";

/** `policy`: read the integration branch's policy, or land a change to its settings fields. */
export async function runPolicy(args: string[]): Promise<number> {
  const [action, ...flags] = args;
  if (action === "show" && (flags.length === 0 || (flags.length === 1 && flags[0] === "--json"))) {
    const view = await showPolicy(process.cwd());
    if (flags[0] === "--json") console.log(JSON.stringify(view, null, 2));
    else {
      console.log(`${view.integrationBranch} @ ${view.revision.slice(0, 12)}${view.declared ? "" : " (no slipjay.json)"}`);
      console.log(`spares: ${view.settings.spares}\nprocess: ${view.settings.process}${view.settings.budgets ? `\nbudgets: ${JSON.stringify(view.settings.budgets)}` : ""}`);
      console.log(`requiredLandingVerification:${view.settings.requiredLandingVerification.length ? "" : " (none)"}`);
      for (const check of view.settings.requiredLandingVerification as { executable: string; args: string[] }[]) console.log(`  ${[check.executable, ...check.args].join(" ")}`);
      const retired = retiredFieldsWarning(view.declared);
      if (retired) console.error(retired);
    }
    return 0;
  }
  if (action !== "set") throw new Error(POLICY_USAGE);
  // With --json-lines, a caller learns the operation as soon as it is followed, then reads the outcome as the last line.
  const jsonLines = flags.includes("--json-lines");
  const onOperation = jsonLines ? (operationId: string) => console.log(JSON.stringify({ phase: "following", operationId })) : undefined;
  // Every failure before submission is a refusal the caller can tell apart from a landing outcome.
  let result: Awaited<ReturnType<typeof setPolicy>>;
  try { result = await runPolicySet(flags.filter((flag) => flag !== "--json-lines"), onOperation); }
  catch (error) { result = { ok: false, phase: "refused", reason: error instanceof Error ? error.message : String(error) }; }
  console.log(jsonLines ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  return result.ok ? 0 : result.phase === "refused" ? 2 : 1;
}

/** `policy set`: parse the flags and land the patch; throws only before anything is submitted. */
async function runPolicySet(flags: string[], onOperation?: (operationId: string) => void): Promise<Awaited<ReturnType<typeof setPolicy>>> {
  let base: string | undefined;
  let patch: Record<string, unknown> = {};
  const json = (flag: string, value: string) => { try { return JSON.parse(value) as unknown; } catch { throw new Error(`${flag} must be JSON`); } };
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index]!, value = flags[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(POLICY_USAGE);
    if (flag === "--base") base = value;
    else if (flag === "--patch") {
      const supplied = json(flag, value);
      if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error("--patch must be a JSON object");
      patch = { ...patch, ...supplied };
    }
    else if (flag === "--spares") patch.spares = value === "default" ? null : Number(value);
    else if (flag === "--process") patch.process = value === "default" ? null : value;
    else if (flag === "--landing-verification") patch.requiredLandingVerification = value === "default" ? null : json(flag, value);
    else throw new Error(POLICY_USAGE);
  }
  if (!base) throw new Error(POLICY_USAGE);
  const location = runnerLocation();
  if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const following = new AbortController();
  const stopFollowing = () => following.abort(new Error("Stopped following; rerun the same slipjay policy set to reattach"));
  process.once("SIGINT", stopFollowing);
  try { return await setPolicy(process.cwd(), { base, patch, location, signal: following.signal, onLine: (line) => console.error(line), ...onOperation ? { onOperation } : {} }); }
  finally { process.removeListener("SIGINT", stopFollowing); }
}
