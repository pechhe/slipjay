/**
 * Where a client finds the runner: the names it reads that location and token from, and the
 * port it defaults to. A leaf of the runner contract, so a module that needs only a name
 * (the machine policy that says where the runner is) does not reach the whole contract.
 */

/** Environment variable holding the runner location (`http://host:port` or `ssh://host`). */
export const RUNNER_LOCATION_ENV = "SLIPJAY_RUNNER";
/** Environment variable, and Bitwarden secret key, holding the bearer token. */
export const RUNNER_TOKEN_ENV = "SLIPJAY_RUNNER_TOKEN";
/** Port the runner binds on 127.0.0.1, and the port an `ssh://` location forwards to. */
export const RUNNER_DEFAULT_PORT = 7787;
