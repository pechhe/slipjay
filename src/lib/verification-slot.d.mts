export const VERIFICATION_SLOT_ENV: "SLIPJAY_VERIFICATION_SLOT";
export function verificationSlotEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** A live contender's record: the holder's, or a waiter's (one its waiter still touches). */
export type VerificationSlotRecord = {
  id: string;
  pid: number;
  since: number;
  label: string | null;
  /** Fields the contender passed as `record`. */
  [field: string]: unknown;
};
export function withVerificationSlot<T>(
  operation: () => Promise<T>,
  options?: {
    env?: NodeJS.ProcessEnv;
    root?: string;
    /** The integration root this landing serializes on; omitted, the slot is machine-wide. */
    scope?: string;
    pollMs?: number;
    signal?: AbortSignal;
    /** This landing's name, shown to landings waiting behind it as `holder`. */
    label?: string;
    /** Structured fields added to this contender's holder and waiting records. */
    record?: Record<string, unknown>;
    /**
     * Asked before each attempt and again once the slot is taken: true stands
     * aside this round (handing back a slot just taken). `waiters` excludes `own`,
     * oldest first; records of dead processes are gone.
     */
    yieldTo?: (status: {
      own: VerificationSlotRecord;
      holder: VerificationSlotRecord | null;
      waiters: VerificationSlotRecord[];
    }) => boolean | Promise<boolean>;
    onWait?: (status: { ahead: number; holder: string | null }) => void;
  },
): Promise<T>;
