import { expect, test } from "vite-plus/test";
import { isTransientRemoteFetchFailure, isTransientRemotePushFailure } from "../../src/lib/infra/remote-push.ts";

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

test.each([
  "Permission denied", "Authentication failed", "repository not found", "HTTP 429",
  "couldn't find remote ref main", "HTTP request failed with status code 403",
])("fetch never retries a permanent diagnostic with transport noise: %s", (detail) => {
  expect(isTransientRemoteFetchFailure(`${detail}\nerror: RPC failed; broken pipe`)).toBe(false);
});

test.each(["remote: Internal Server Error", "HTTP/2 503", "HTTP status code: 502", "early EOF", "TLS handshake failure"])(
  "fetch retries transport and server failures: %s", (detail) => {
    expect(isTransientRemoteFetchFailure(detail)).toBe(true);
  },
);

test.each(["refs/heads/main (reason: failed)", "local file size: 503", "unable to write file", ""])(
  "does not retry unclassified errors: %s", (detail) => {
    expect(isTransientRemotePushFailure(detail)).toBe(false);
  },
);

test.each([
  "kex_exchange_identification: read: Connection reset by peer",
  "Connection closed by remote host",
  "Connection closed by 140.82.112.4 port 22",
  "client_loop: send disconnect: Broken pipe",
  "mux_client_request_session: read from master failed",
  "ssh: connect to host github.com port 22: Connection refused",
  "ssh: connect to host github.com port 22: Network is unreachable",
])("ssh transport failures are transient for fetch and push: %s", (detail) => {
  expect(isTransientRemoteFetchFailure(detail)).toBe(true);
  expect(isTransientRemotePushFailure(detail)).toBe(true);
});

test("a bare 'Could not read from remote repository' is a transient fetch failure", () => {
  expect(isTransientRemoteFetchFailure("fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.")).toBe(true);
});

test.each([
  "Host key verification failed.",
  "git@github.com: Permission denied (publickey).",
  "ERROR: Repository not found.",
  "fatal: 'x' does not appear to be a git repository",
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
])("permanent ssh/git failures are never retried even with 'Could not read from remote repository': %s", (detail) => {
  expect(isTransientRemoteFetchFailure(`${detail}\nfatal: Could not read from remote repository.`)).toBe(false);
  expect(isTransientRemoteFetchFailure(detail)).toBe(false);
});
