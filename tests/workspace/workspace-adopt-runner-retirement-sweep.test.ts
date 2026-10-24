import { test } from "vite-plus/test";
import { isolateAdoptionFixtures } from "./fixtures/workspace-adopt-fixture.ts";
import { runAdoptionRetirementCase } from "./fixtures/workspace-adopt-retirement-case.ts";

isolateAdoptionFixtures();

test("published adoption survives lead retirement: sweep", async () => { await runAdoptionRetirementCase("sweep"); }, 180_000);
