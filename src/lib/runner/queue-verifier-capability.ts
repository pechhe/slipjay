import { machineBuildLease, machineConnections, machineVerification } from "./machine-verifier.ts";
import { hostMachine, openHostAttempt } from "./host-verifier.ts";
import { HostCapacityUnavailable } from "./host-capacity-remote.ts";
import type { VerifierCapability } from "./runner-queue-capabilities.ts";

export const verifierCapability: VerifierCapability = {
  machineBuildLease,
  machineConnections,
  machineVerification,
  hostMachine,
  openHostAttempt,
  isHostCapacityUnavailable: (error) => error instanceof HostCapacityUnavailable,
};
