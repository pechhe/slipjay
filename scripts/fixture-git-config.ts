// Both test entry points create a disposable HOME before writing this identity.
// Git children inherit it without changing the developer's configuration.
export const FIXTURE_GIT_IDENTITY = "[user]\n\tname = Fixture\n\temail = fixture@example.com\n";
