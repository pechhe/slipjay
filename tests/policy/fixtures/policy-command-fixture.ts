// A landing check that takes five minutes: a settings landing that ran it would time the test out.
export const slowGateMs = 300_000;
export const slowGate = () => `setTimeout(() => {}, ${slowGateMs})`;
