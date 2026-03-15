import { createRoute } from "furinjs/client";
import { Link, type RouteTo } from "furinjs/link";
import { client } from "../../client";
import { route as rootRoute } from "../root";

export const route = createRoute({
  parent: rootRoute,
  loader: async ({ request }) => {
    const cookieHeader = request?.headers.get("Cookie") ?? "";
    const { data } = await client.api.me.get({
      fetch: { headers: cookieHeader ? { Cookie: cookieHeader } : {} },
    });
    if (!data) {
      throw new Error("error");
    }

    return {
      ...data,
      pathname: request ? new URL(request.url).pathname : "",
    };
  },

  layout: ({ children, user, pathname }) => {
    if (!user) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-gray-50">
          <div className="text-center">
            <h1 className="mb-4 font-bold text-2xl text-gray-900">Access Denied</h1>
            <p className="mb-6 text-gray-600">You need to be signed in to access the dashboard.</p>
            <Link
              className="rounded-lg bg-indigo-600 px-6 py-3 font-medium text-white hover:bg-indigo-700"
              to="/login"
            >
              Sign In
            </Link>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-gray-100">
        <div className="flex">
          <aside className="min-h-screen w-64 border-gray-200 border-r bg-white">
            <div className="p-6">
              <Link className="font-bold text-indigo-600 text-xl" to="/">
                Elyra
              </Link>
            </div>
            <nav className="space-y-1 px-4">
              <NavItem icon="home" label="Dashboard" pathname={pathname} to="/dashboard" />
              <NavItem
                icon="document"
                label="Posts"
                pathname={pathname}
                to="/dashboard/posts/new"
              />
              <NavItem icon="settings" label="Settings" pathname={pathname} to="/dashboard" />
            </nav>
          </aside>

          <main className="flex-1">
            <header className="border-gray-200 border-b bg-white px-8 py-4">
              <div className="flex items-center justify-between">
                <h1 className="font-semibold text-gray-900 text-xl">Admin Dashboard</h1>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-700 text-sm">{user.name}</span>
                  </div>
                  <a
                    className="text-gray-500 text-sm hover:text-gray-700"
                    href="/api/logout"
                    onClick={(e) => {
                      e.preventDefault();
                      fetch("/api/logout", { method: "POST" }).then(() => {
                        location.href = "/login";
                      });
                    }}
                  >
                    Sign Out
                  </a>
                </div>
              </div>
            </header>

            <div className="p-8">{children}</div>
          </main>
        </div>
      </div>
    );
  },
});

function NavItem({
  to,
  icon,
  label,
  pathname,
}: {
  to: RouteTo;
  icon: string;
  label: string;
  pathname: string;
}) {
  const isActive = pathname === to;

  const icons: Record<string, React.ReactNode> = {
    home: (
      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>home</title>
        <path
          d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
    document: (
      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>document</title>
        <path
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
    settings: (
      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <title>settings</title>
        <path
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
        <path
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    ),
  };

  return (
    <Link
      className={`flex items-center gap-3 rounded-lg px-4 py-2 transition-colors ${
        isActive ? "bg-indigo-50 text-indigo-600" : "text-gray-600 hover:bg-gray-50"
      }`}
      preload="render"
      to={to}
    >
      {icons[icon]}
      <span className="font-medium">{label}</span>
    </Link>
  );
}
