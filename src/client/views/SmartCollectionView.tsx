import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, smartCollectionQueryOptions } from "../api.ts";
import { SmartEditor } from "../components/SmartEditor.tsx";
import { useSmartCollections } from "../smart-collections-context.tsx";

/**
 * `/smart/{id}`: the saved editor. Name and Rule edits autosave after the
 * explicit first save, and Delete returns to the Library.
 */
export function SmartCollectionView() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { reload, remove } = useSmartCollections();
  const queryOptions = smartCollectionQueryOptions(id);
  const collectionQuery = useQuery({ ...queryOptions, enabled: id !== "" });
  const collection = collectionQuery.data ?? null;
  const missing =
    id === "" ||
    (collectionQuery.error instanceof ApiError && collectionQuery.error.status === 404);
  const error =
    collectionQuery.error !== null && !(collectionQuery.error instanceof ApiError)
      ? collectionQuery.error.message
      : collectionQuery.error instanceof ApiError && collectionQuery.error.status !== 404
        ? collectionQuery.error.message
        : null;

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
        <button type="button" className="button" onClick={() => void collectionQuery.refetch()}>
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
        queryClient.setQueryData(queryOptions.queryKey, saved);
        void reload();
      }}
      onDeleted={() => {
        remove(collection.id);
        queryClient.removeQueries({ queryKey: queryOptions.queryKey });
        void reload();
        navigate("/");
      }}
    />
  );
}
