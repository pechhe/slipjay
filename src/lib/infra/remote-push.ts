/** Delays before the two retries of a failed push. No delay or retry on a confirmed update. */
export const remotePushRetryDelaysMs: readonly number[] = [1_000, 3_000];

const permanent = [
  /non[- ]fast[- ]forward|stale[- ](?:info|(?:remote )?ref)|fetch first|refs? (?:have|has) changed|refusing to push/i,
  /(?:cannot|could not|unable to|failed to) lock|\.lock\b|lock (?:ref|file|failed)|acquire (?:the )?lock/i,
  /permission denied|authentication failed|access denied|authorization failed|not authorized|protected branch|hook declined|repository rule/i,
  /(?:\bHTTP(?:\/\d+(?:\.\d+)?)?(?: (?:status|error))?[ :]+|returned error:[ \t]*)4\d\d\b/i,
];
const transient = [
  /remote:\s*(?:error:\s*unable to write file|fatal:\s*(?:unable to rename temporary|unpack)|(?:error:\s*)?internal server error)|\bunpack failed\b/i,
  /(?:\bHTTP(?:\/\d+(?:\.\d+)?)?(?: (?:status|error))?[ :]+|returned error:[ \t]*)(?:500|502|503|504)\b/i,
  /connection (?:reset|timed out)|could not resolve host|early EOF|broken pipe|unexpected disconnect|RPC failed|the remote end hung up unexpectedly/i,
  /(?:TLS|SSL)[^\r\n]*handshake|SSL_connect|temporary failure in name resolution/i,
];

/** Retry only known receive-pack/transport failures; explicit rejections take precedence. */
export function isTransientRemotePushFailure(detail: string): boolean {
  return !permanent.some((pattern) => pattern.test(detail)) && transient.some((pattern) => pattern.test(detail));
}
