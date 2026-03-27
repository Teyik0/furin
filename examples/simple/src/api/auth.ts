import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { Elysia } from "elysia";
import { db } from "../db";
import { accounts, sessions, users, verifications } from "../db/schema";

const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
if (!(githubClientId && githubClientSecret)) {
  throw new Error(
    "[auth] Missing required environment variables: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set."
  );
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),
  socialProviders: {
    github: {
      clientId: githubClientId,
      clientSecret: githubClientSecret,
    },
  },
});

export const authPlugin = new Elysia({ name: "better-auth" }).mount(auth.handler).macro({
  auth: {
    async resolve({ status, request: { headers } }) {
      const session = await auth.api.getSession({ headers });
      if (!session) {
        return status(401);
      }
      return {
        user: session.user,
        session: session.session,
      };
    },
  },
});
