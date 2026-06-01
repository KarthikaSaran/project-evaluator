"use client";

import { useEffect, useState, useCallback } from "react";

export interface AuthStatus {
  signedIn: boolean;
  configured: boolean;
  email?: string;
}

interface Props {
  onChange?: (status: AuthStatus) => void;
  compact?: boolean;
}

export default function GoogleSignIn({ onChange, compact = false }: Props) {
  const [status, setStatus] = useState<AuthStatus | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/google/status", { cache: "no-store" });
      const data = (await r.json()) as AuthStatus;
      setStatus(data);
      onChange?.(data);
    } catch {
      const fallback: AuthStatus = { signedIn: false, configured: false };
      setStatus(fallback);
      onChange?.(fallback);
    }
  }, [onChange]);

  useEffect(() => {
    fetchStatus();
    // If we just came back from the OAuth callback, clear the URL marker
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      if (u.searchParams.has("auth") || u.searchParams.has("auth_error")) {
        u.searchParams.delete("auth");
        u.searchParams.delete("auth_error");
        window.history.replaceState({}, "", u.toString());
      }
    }
  }, [fetchStatus]);

  const signOut = async () => {
    await fetch("/api/auth/google/logout", { method: "POST" });
    await fetchStatus();
  };

  if (!status) {
    return <div className="text-xs text-gray-400">…</div>;
  }

  if (!status.configured) {
    return (
      <div
        className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1"
        title="Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and SESSION_SECRET env vars to enable Drive sign-in"
      >
        Drive sign-in not configured
      </div>
    );
  }

  if (!status.signedIn) {
    return (
      <a
        href="/api/auth/google/start"
        className={`inline-flex items-center gap-2 ${
          compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"
        } font-medium border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 transition-colors`}
      >
        <GoogleIcon />
        Sign in with Google
      </a>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div
        className={`inline-flex items-center gap-1.5 ${
          compact ? "text-xs" : "text-sm"
        } text-gray-700 bg-green-50 border border-green-200 rounded-lg px-2.5 py-1`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
        <span className="truncate max-w-[200px]">{status.email}</span>
      </div>
      <button
        type="button"
        onClick={signOut}
        className="text-xs text-gray-400 hover:text-gray-700"
      >
        Sign out
      </button>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20.5H24v7.5h11.3c-1.6 4.4-5.9 7.5-11.3 7.5-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8.1 3.1l5.3-5.3C34 6 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.2 4.5C14.1 15.1 18.7 12 24 12c3.1 0 5.9 1.2 8.1 3.1l5.3-5.3C34 6 29.3 4 24 4 16.3 4 9.7 8.4 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.3 35 26.7 36 24 36c-5.4 0-9.7-3-11.3-7.4l-6.2 4.8C9.8 39.6 16.3 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20.5H24v7.5h11.3c-.8 2.2-2.2 4.1-4.1 5.4l6.2 5.2c-.4.4 6.6-4.8 6.6-14.1 0-1.3-.1-2.6-.4-3.5z"
      />
    </svg>
  );
}
