import { log } from "evlog/client";
import { authClient } from "@/lib/auth-client";
import { route } from "./root";

export default route.page({
  component: () => {
    const handleLogin = async () => {
      log.info({ action: "test_log", from: "homepage" });
      await authClient.signIn.social({
        provider: "github",
        callbackURL: "/docs",
      });
    };

    return (
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-2 text-center">
            <h1 className="font-bold text-2xl tracking-tight">Sign in</h1>
            <p className="text-muted-foreground text-sm">
              Sign in with your GitHub account to leave comments on the docs.
            </p>
          </div>

          <button
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-border bg-background px-4 py-2.5 font-medium text-sm transition-colors hover:bg-muted"
            onClick={handleLogin}
            type="button"
          >
            <svg aria-hidden="true" fill="currentColor" height="20" viewBox="0 0 24 24" width="20">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            Continue with GitHub
          </button>
        </div>
      </div>
    );
  },
});
