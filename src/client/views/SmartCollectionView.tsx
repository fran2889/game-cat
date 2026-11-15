import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { SmartCollection } from "../../shared/smart-collections.ts";
import { ApiError, fetchSmartCollection } from "../api.ts";
import { SmartEditor } from "../components/SmartEditor.tsx";
import { useSmartCollections } from "../smart-collections-context.tsx";

/**
 * `/smart/{id}`: the saved editor. Name and Rule edits autosave after the
 * explicit first save, and Delete returns to the Library.
 */
export function SmartCollectionView() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { reload, remove } = useSmartCollections();
  const [collection, setCollection] = useState<SmartCollection | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (id === "") {
        setMissing(true);
        return;
      }
      setError(null);
      void fetchSmartCollection(id, signal)
        .then((next) => {
          setCollection(next);
          setMissing(false);
        })
        .catch((fetchError: unknown) => {
          if ((fetchError as Error).name === "AbortError") {
            return;
          }
          if (fetchError instanceof ApiError && fetchError.status === 404) {
            setMissing(true);
          } else {
            setError((fetchError as Error).message);
          }
        });
    },
    [id],
  );

  useEffect(() => {
    setCollection(null);
    setMissing(false);
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (missing) {
    return (
      <section className="empty-library" aria-labelledby="smart-collection-missing">
        <h2 id="smart-collection-missing">Smart Collection not found.</h2>
        <p>It may have been deleted. Choose another Collection from the sidebar.</p>
        <div className="empty-actions">
          <Link to="/" className="button">
            Back to the Library
          </Link>
        </div>
      </section>
    );
  }

  if (error !== null) {
    return (
      <div className="banner banner-error" role="alert">
        <div>
          <strong>Cannot load this Smart Collection.</strong>
          <p>{error}</p>
        </div>
        <button type="button" className="button" onClick={() => load()}>
          Retry
        </button>
      </div>
    );
  }

  if (collection === null) {
    return (
      <section
        className="library-loading"
        aria-busy="true"
        aria-label="Loading the Smart Collection"
      >
        <div className="skeleton-grid">
          {Array.from({ length: 4 }, (_, index) => (
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

  return (
    <SmartEditor
      key={collection.id}
      collection={collection}
      onSaved={(saved) => {
        setCollection(saved);
        void reload();
      }}
      onDeleted={() => {
        remove(collection.id);
        void reload();
        navigate("/");
      }}
    />
  );
}
