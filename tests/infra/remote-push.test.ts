import { expect, test } from "vite-plus/test";
import { isTransientRemotePushFailure } from "../../src/lib/infra/remote-push.ts";

test.each([
  "remote: error: unable to write file /data/repositories/demo/objects/ghq_Dn4Y0bInQmZ/pack/pack-123.pack: No such file or directory\n"
    + "remote: fatal: unable to rename temporary 'tmp.pack' file\nWarning: The remote rejected the following updates:\n  refs/heads/master (reason: failed)",
  "remote: fatal: unable to rename temporary 'tmp.pack' file",
  "remote: fatal: unpack failed",
  "error: unpack failed: unpack-objects abnormal exit",
  "remote: Internal Server Error",
  "error: RPC failed; HTTP 500 curl 22",
  "fatal: The requested URL returned error: 502",
  "HTTP/2 503 Service Unavailable",
  "HTTP 504",
  "Connection reset by peer",
  "Connection timed out",
  "Could not resolve host: github.com",
  "fatal: early EOF",
  "broken pipe",
  "unexpected disconnect",
  "error: RPC failed",
  "The remote end hung up unexpectedly",
  "TLS handshake failure",
  "SSL handshake failed",
  "Temporary failure in name resolution",
])("retries transient diagnostics: %s", (detail) => {
  expect(isTransientRemotePushFailure(detail)).toBe(true);
});

test.each([
  "non-fast-forward",
  "stale info",
  "fetch first",
  "remote: error: cannot lock ref 'refs/heads/main'",
  "Permission denied",
  "Authentication failed",
  "protected branch",
  "pre-receive hook declined",
  "HTTP 403",
])("permanent diagnostics take precedence over transport noise: %s", (detail) => {
  expect(isTransientRemotePushFailure(`${detail}\nerror: RPC failed; broken pipe`)).toBe(false);
});

test.each(["refs/heads/main (reason: failed)", "local file size: 503", "unable to write file", ""])(
  "does not retry unclassified errors: %s", (detail) => {
    expect(isTransientRemotePushFailure(detail)).toBe(false);
  },
);
