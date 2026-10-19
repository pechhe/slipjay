// A landing check that takes five minutes: a settings landing that ran it would time the test out.
export const slowGate = () => "setTimeout(() => {}, 300_000)";
