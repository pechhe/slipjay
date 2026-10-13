const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The remote `land` pushes to: top-level `remote` or legacy `sourcePublication.remote`. */
interface PublicationPolicy {
  remote?: unknown;
  sourcePublication?: { remote?: unknown } | null;
}

export function declaredPublicationRemote(policy: PublicationPolicy | null | undefined): string | null {
  const value = policy?.remote ?? policy?.sourcePublication?.remote;
  if (value === undefined) return null;
  if (typeof value !== "string" || !REMOTE.test(value)) {
    throw new Error("Invalid publication remote in the repository policy: expected one named remote");
  }
  return value;
}
