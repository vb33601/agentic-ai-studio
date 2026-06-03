"use client";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ background: "#09090b", color: "#fafafa", fontFamily: "system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "1rem" }}>
            Something went wrong
          </h1>
          {error.digest && (
            <p style={{ color: "#71717a", fontSize: "0.875rem", marginBottom: "1rem" }}>
              Error ID: {error.digest}
            </p>
          )}
          <button
            onClick={unstable_retry}
            style={{ padding: "0.5rem 1rem", background: "#27272a", border: "1px solid #3f3f46", borderRadius: "0.5rem", color: "#fafafa", cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
