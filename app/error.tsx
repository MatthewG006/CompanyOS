"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page-wrap">
      <div className="panel state-panel" role="alert">
        <h1>Something went wrong</h1>
        <p className="muted">This page hit an unexpected error. Your data is safe — nothing was changed. Trying again usually clears it; if it keeps happening, note the reference below.</p>
        {error.digest ? <p className="muted">Reference: {error.digest}</p> : null}
        <button type="button" className="refresh-button" onClick={reset}>Try again</button>
      </div>
    </div>
  );
}
