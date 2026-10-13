/** Declarations of `slipjay cutover`; see cutover.mjs. */
/** Everything holding or about to take a lock or run in a slipjay state directory, one line each. */
export function cutoverHolders(root?: string): Promise<string[]>;

export type CutoverResult =
  | { status: "refused"; holders: string[] }
  | { status: "ready"; holders: []; from: { state: string; mode: string }; to: { state: string; mode: string } }
  | { status: "already-cut-over"; marker: string; holders: []; reappeared?: string[] }
  | {
    status: "cut-over"; marker: string; holders: []; version: 1; cutoverAt: string;
    from: { state: string; mode: string }; to: { state: string; mode: string };
    state: string; mode: string;
  };

/** Run the cutover, or with `check` only report whether it would run. */
export function cutover(options?: {
  check?: boolean;
  io?: { rename?: (from: string, to: string) => Promise<void> };
}): Promise<CutoverResult>;
