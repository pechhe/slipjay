/**
 * The Build handoff `slipjay land` writes itself in a Build-tracked repository, so a landing
 * always reaches Build: a workspace with no item lands as a chore, and one with an item lands
 * as delivery of that item's Spec under the lead's current bind and the session the caller
 * names. Nothing about the bind or session is guessed: what Build cannot confirm is refused
 * here, before anything is submitted, and Build's admission checks the session itself.
 */
import { readBuildItem } from "./tracker.ts";
import type { BuildItem, BuildReader } from "./tracker.ts";
import type { BuildBinding, SubmissionHandoff } from "../landing/submission-handoff.ts";

/** Where `slipjay land` takes the lead's Build session from when `--session` is not given. */
export const BUILD_SESSION_ENV = "HQ_BUILD_SESSION_ID";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Bind = { generation: number; endedAt: string | null };

export type BuildHandoffRequest = {
  /** The exact commit being landed and its description. */
  source: string; description: string;
  /** The workspace's Build item, or null for a chore. */
  issueNumber: number | null;
  /** Further Tickets of the same Spec the landing completes. */
  tickets: number[];
  /** The lead's open Build session, from `--session` or `HQ_BUILD_SESSION_ID`. */
  sessionId: string | undefined;
  read: BuildReader;
};

async function item(read: BuildReader, reference: { number: number } | { itemId: string }, label: string): Promise<BuildItem> {
  const found = await readBuildItem(read, reference);
  if (!found) throw new Error(`Build has no item ${label}`);
  return found;
}

/** The binding for a landing of Build item `issueNumber`, or the chore statement when it has none. */
async function binding(request: BuildHandoffRequest): Promise<BuildBinding | { unassociated: true }> {
  const { issueNumber, tickets, read } = request;
  if (issueNumber === null) {
    if (tickets.length) throw new Error("--ticket needs a workspace with a Build item: start it with --issue <n> or attach-issue <n>");
    // A session id says the landing is a Spec's: landing it as a chore would leave the Spec unlanded without a word.
    if (request.sessionId?.trim()) throw new Error(`A Build session needs a workspace with a Build item: attach the Spec with attach-issue <n> (or start it with --issue <n>), or drop --session/${BUILD_SESSION_ENV} to land a chore`);
    return { unassociated: true };
  }
  const named = await item(read, { number: issueNumber }, `#${issueNumber}`);
  const spec = named.kind === "spec" ? named
    : named.kind === "ticket" && named.parentId ? await item(read, { itemId: named.parentId }, `for #${issueNumber}'s Spec`) : null;
  if (!spec || spec.kind !== "spec")
    throw new Error(`Build #${issueNumber} is a ${named.kind}, not a Spec or a Spec's Ticket: land it with --handoff, or attach the workspace to its Spec or Ticket`);
  const ticketIds = named.kind === "ticket" ? [named.id] : [];
  for (const number of tickets) {
    const ticket = await item(read, { number }, `#${number}`);
    if (ticket.kind !== "ticket" || ticket.parentId !== spec.id) throw new Error(`Build #${number} is not a Ticket of Spec #${spec.number}`);
    if (!ticketIds.includes(ticket.id)) ticketIds.push(ticket.id);
  }
  // Build binds only a shaped Spec, so an Inbox or Shaping one needs shaping before any lead session.
  if (spec.status === "inbox" || spec.status === "shaping")
    throw new Error(`Landing Build #${issueNumber} needs Spec #${spec.number} shaped and bound, but it is in ${spec.status}: set it to ready with hq_build_set_status (inbox → shaping → ready), bind it with hq_build_bind, start a session with hq_build_start_session, then pass --session <id> or set ${BUILD_SESSION_ENV}`);
  const sessionId = request.sessionId?.trim();
  if (!sessionId)
    throw new Error(`Landing Build #${issueNumber} needs your lead session for Spec #${spec.number}: start one with hq_build_start_session, then pass --session <id> or set ${BUILD_SESSION_ENV}`);
  if (!UUID.test(sessionId)) throw new Error(`The Build session ${JSON.stringify(sessionId)} is not a session id`);
  const binds = await read("binds", { specId: spec.id }) as Bind[];
  const current = binds.filter((bind) => bind.endedAt === null).at(-1);
  if (!current) throw new Error(`Spec #${spec.number} has no current lead: bind it with hq_build_bind before landing`);
  return { specId: spec.id, ticketIds, bodyRevision: spec.bodyRevision ?? null,
    bindGeneration: current.generation, sessionId };
}

export async function buildLandingHandoff(request: BuildHandoffRequest): Promise<SubmissionHandoff> {
  const intent = request.description.split("\n")[0]!.trim().slice(0, 2000) || "Landing";
  return {
    version: 1, source: request.source, intent, scope: [request.issueNumber ? `Build #${request.issueNumber}` : "chore"], spec: null,
    build: await binding(request),
    helpers: [], checks: [], reviews: [], toolchain: [],
    gaps: ["Written by slipjay land from the workspace's Build item; the author supplied no evidence"],
  };
}
