import { Link } from "@teyik0/elysion/link";
import { useState } from "react";
import { client } from "../client";
import { route } from "./root";

export default route.page({
  component: () => {
    const [email, setEmail] = useState("");
    const [message, setMessage] = useState("");
    const [isLoading, setIsLoading] = useState(false);

    const handleLogin = async (e: React.SubmitEvent) => {
      e.preventDefault();
      setIsLoading(true);
      setMessage("");

      console.log("login started");
      const { data, error } = await client.api.login.post({ email });

      if (data) {
        setMessage("Connected! Redirecting...");
        setTimeout(() => {
          location.href = "/dashboard";
        }, 1000);
      } else {
        console.log("login error", error);
        setMessage(error?.value?.message ?? "Login failed");
      }

      setIsLoading(false);
    };

    return (
      <main className="flex min-h-[80vh] items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <Link className="font-bold text-2xl text-indigo-600" to="/">
              Elysion Blog
            </Link>
            <h1 className="mt-4 font-bold text-3xl text-gray-900">Sign in to your account</h1>
            <p className="mt-2 text-gray-600">Access the admin dashboard to manage your posts</p>
          </div>

          <div className="border border-gray-200 bg-white px-4 py-8 shadow sm:rounded-lg sm:px-10">
            <form className="space-y-6" onSubmit={handleLogin}>
              <div>
                <label className="mb-1 block font-medium text-gray-700 text-sm" htmlFor="email">
                  Email address
                </label>
                <input
                  autoComplete="email"
                  className="block w-full appearance-none rounded-md border border-gray-300 px-3 py-2 placeholder-gray-400 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  id="email"
                  name="email"
                  onChange={(e) => setEmail(e.currentTarget.value)}
                  placeholder="user@example.com"
                  required
                  type="email"
                  value={email}
                />
              </div>

              <div>
                <button
                  className="flex w-full justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 font-medium text-sm text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
                  disabled={isLoading}
                  type="submit"
                >
                  {isLoading ? "Signing in..." : "Sign in"}
                </button>
              </div>

              {message && (
                <div
                  className={`rounded-md p-3 text-sm ${
                    message.includes("Connected")
                      ? "bg-green-50 text-green-700"
                      : "bg-red-50 text-red-700"
                  }`}
                >
                  {message}
                </div>
              )}
            </form>

            <div className="mt-6">
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-gray-300 border-t" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="bg-white px-2 text-gray-500">Demo accounts</span>
                </div>
              </div>

              <div className="mt-6 space-y-3">
                <button
                  className="flex w-full items-center justify-between rounded-md border border-gray-300 px-4 py-3 transition-colors hover:bg-gray-50"
                  onClick={() => setEmail("user@example.com")}
                  type="button"
                >
                  <div className="flex items-center">
                    <div className="mr-3 flex h-8 w-8 items-center justify-center rounded-full bg-blue-100">
                      <span className="font-medium text-blue-600 text-sm">JD</span>
                    </div>
                    <div className="text-left">
                      <p className="font-medium text-gray-900 text-sm">John Doe</p>
                      <p className="text-gray-500 text-xs">user@example.com</p>
                    </div>
                  </div>
                  <span className="rounded bg-blue-100 px-2 py-1 text-blue-700 text-xs">User</span>
                </button>

                <button
                  className="flex w-full items-center justify-between rounded-md border border-gray-300 px-4 py-3 transition-colors hover:bg-gray-50"
                  onClick={() => setEmail("admin@example.com")}
                  type="button"
                >
                  <div className="flex items-center">
                    <div className="mr-3 flex h-8 w-8 items-center justify-center rounded-full bg-purple-100">
                      <span className="font-medium text-purple-600 text-sm">AU</span>
                    </div>
                    <div className="text-left">
                      <p className="font-medium text-gray-900 text-sm">Admin User</p>
                      <p className="text-gray-500 text-xs">admin@example.com</p>
                    </div>
                  </div>
                  <span className="rounded bg-purple-100 px-2 py-1 text-purple-700 text-xs">
                    Admin
                  </span>
                </button>
              </div>
            </div>
          </div>

          <p className="mt-4 text-center text-gray-500 text-sm">
            This is a demo. Click on any account above to auto-fill the email.
          </p>
        </div>
      </main>
    );
  },
});
