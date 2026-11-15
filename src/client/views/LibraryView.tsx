import { Link, useOutletContext } from "react-router-dom";
import type { ShellContext } from "../shell-context.ts";
import { useToast } from "../components/ToastProvider.tsx";

export interface LibraryViewProps {
  mode: "all" | "installed";
}

export function LibraryView({ mode }: LibraryViewProps) {
  const { status } = useOutletContext<ShellContext>();
  const { showToast } = useToast();

  if (status === null) {
    return (
      <section className="library-loading" aria-busy="true" aria-label="Loading the Library">
        <div className="skeleton-grid">
          {Array.from({ length: 8 }, (_, index) => (
            <div className="skeleton-card" key={index}>
              <div className="skeleton-cover" />
              <div className="skeleton-line" />
              <div className="skeleton-line short" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const isInstalled = mode === "installed";
  const heading = isInstalled ? "No installed games found." : "No games found.";
  const steamRoot = status.steam.root;

  return (
    <section className="empty-library" aria-labelledby="empty-heading">
      <div className="empty-illustration" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h2 id="empty-heading">{heading}</h2>
      <p>
        {isInstalled
          ? "Installed games appear once Steam reports an app manifest for them."
          : "Nothing has been scanned yet. A moved Steam library, a Flatpak install, or a fresh Steam install can all leave this list empty."}
      </p>
      {steamRoot !== null ? (
        <p className="empty-path">
          Steam root: <code>{steamRoot}</code>
        </p>
      ) : (
        <p className="empty-path">
          Steam was not found. Install or start Steam, or set <code>GAME_CAT_STEAM_ROOT</code>.
        </p>
      )}
      <div className="empty-actions">
        <button
          type="button"
          className="primary"
          onClick={() => showToast("Scanning arrives in a later build. Nothing was changed.")}
        >
          Scan again
        </button>
        <button
          type="button"
          className="button"
          onClick={() => showToast("Changing the Steam folder arrives with onboarding.")}
        >
          Change Steam folder
        </button>
        <Link to="/onboarding" className="button">
          Open setup
        </Link>
      </div>
      <p className="empty-note">
        {status.ownership.state === "not_configured"
          ? "A Steam Web API key is required before the first Fetch. The Library is incomplete without it."
          : "The Library will populate after the first Refresh completes."}
      </p>
    </section>
  );
}
