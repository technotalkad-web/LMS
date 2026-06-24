/**
 * Seeds ONE shared test world for the whole bot run and persists its handle
 * (slugs + credentials) to bot-report/seed.json so every spec/worker can log
 * in against the same data. Reuses the existing e2e service-role helpers so we
 * stay on the same naming convention the teardown purge already knows how to
 * clean up (qa-* slugs, *@example.test emails).
 *
 * global-setup calls seedWorld(); global-teardown calls purgeAllTestData().
 */

import fs from "node:fs";
import path from "node:path";
import {
  addMember,
  createAuthUser,
  createOrg,
  markPlatformOwner,
} from "../../e2e/helpers/supabase";
import { SEED_FILE } from "./paths";

export interface SeedUser {
  email: string;
  password: string;
  id: string;
}

export interface SeedWorld {
  org: { id: string; name: string; slug: string };
  admin: SeedUser;
  analyst: SeedUser;
  learner: SeedUser;
  platformOwner: SeedUser;
}

export async function seedWorld(): Promise<SeedWorld> {
  const org = await createOrg({ name: "QA Bot Org" });

  const admin = await createAuthUser({
    profile: { first_name: "Bot", last_name: "Admin", must_change_password: false },
  });
  await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });

  const analyst = await createAuthUser({
    profile: { first_name: "Bot", last_name: "Analyst", must_change_password: false },
  });
  await addMember({ organizationId: org.id, userId: analyst.id, role: "data_analyst" });

  const learner = await createAuthUser({
    profile: { first_name: "Bot", last_name: "Learner", must_change_password: false },
  });
  await addMember({ organizationId: org.id, userId: learner.id, role: "member" });

  const platformOwner = await createAuthUser({
    profile: { first_name: "Bot", last_name: "Owner", must_change_password: false },
  });
  await markPlatformOwner(platformOwner.id);

  const world: SeedWorld = {
    org,
    admin: { email: admin.email, password: admin.password, id: admin.id },
    analyst: { email: analyst.email, password: analyst.password, id: analyst.id },
    learner: { email: learner.email, password: learner.password, id: learner.id },
    platformOwner: {
      email: platformOwner.email,
      password: platformOwner.password,
      id: platformOwner.id,
    },
  };

  fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
  fs.writeFileSync(SEED_FILE, JSON.stringify(world, null, 2));
  return world;
}

/** Read the seed handle persisted by global-setup. Throws if missing. */
export function readSeed(): SeedWorld {
  if (!fs.existsSync(SEED_FILE)) {
    throw new Error(
      `Seed file not found at ${SEED_FILE}. Did global-setup run? ` +
        `Run via: npm run test:bot (uses playwright.bot.config.ts).`
    );
  }
  return JSON.parse(fs.readFileSync(SEED_FILE, "utf8")) as SeedWorld;
}
