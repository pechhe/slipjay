/** Delays before the two retries of a transient remote Git failure. */
export const remotePushRetryDelaysMs: readonly number[] = [1_000, 3_000];

const permanent = [
  /non[- ]fast[- ]forward|stale[- ](?:info|(?:remote )?ref)|fetch first|refs? (?:have|has) changed|refusing to push/i,
  /(?:cannot|could not|unable to|failed to) lock|\.lock\b|lock (?:ref|file|failed)|acquire (?:the )?lock/i,
  /permission denied|authentication failed|access denied|authorization failed|not authorized|protected branch|hook declined|repository rule/i,
  /(?:\bHTTP(?:\/\d+(?:\.\d+)?)?(?: (?:status(?: code)?|error))?[ :]+|\b(?:status code|returned error)[ :\t]+)4\d\d\b/i,
];
const receivePack = /remote:\s*(?:error:\s*unable to write file|fatal:\s*(?:unable to rename temporary|unpack)|(?:error:\s*)?internal server error)|\bunpack failed\b/i;
const transport = [
  /(?:\bHTTP(?:\/\d+(?:\.\d+)?)?(?: (?:status(?: code)?|error))?[ :]+|\b(?:status code|returned error)[ :\t]+)(?:500|502|503|504)\b/i,
  /connection (?:reset|timed out)|could not resolve host|early EOF|broken pipe|unexpected disconnect|RPC failed|the remote end hung up unexpectedly/i,
  /(?:TLS|SSL)[^\r\n]*handshake|SSL_connect|temporary failure in name resolution/i,
];

/** Retry only known receive-pack/transport failures; explicit rejections take precedence. */
export function isTransientRemotePushFailure(detail: string): boolean {
  return !permanent.some((pattern) => pattern.test(detail)) && (receivePack.test(detail) || transport.some((pattern) => pattern.test(detail)));
}

export function isTransientRemoteFetchFailure(detail: string): boolean {
  return !/\bnot found\b|(?:could not|couldn't|cannot) find remote ref/i.test(detail)
    && !permanent.some((pattern) => pattern.test(detail))
    && (transport.some((pattern) => pattern.test(detail)) || /remote:\s*(?:error:\s*)?internal server error/i.test(detail));
}

/** Fetches are safe to repeat; unlike pushes they do not move any remote ref. */
export async function retryRemoteFetch<T extends { code: number; stderr: string; stdout: string }>(
  fetch: () => Promise<T>, delaysMs: readonly number[],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const result = await fetch();
    const delay = delaysMs[attempt];
    if (result.code === 0 || delay === undefined || !isTransientRemoteFetchFailure(`${result.stderr}\n${result.stdout}`)) return result;
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}
