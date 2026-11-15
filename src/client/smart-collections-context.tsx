import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { SmartCollectionListItem } from "../shared/smart-collections.ts";
import { fetchSmartCollections } from "./api.ts";

interface SmartCollectionsContextValue {
  collections: SmartCollectionListItem[];
  loading: boolean;
  error: string | null;
  reload(): Promise<void>;
  remove(id: string): void;
}

const SmartCollectionsContext = createContext<SmartCollectionsContextValue | null>(null);

const PAGE_SIZE = 200;

async function loadAllCollections(): Promise<SmartCollectionListItem[]> {
  const items: SmartCollectionListItem[] = [];
  let page = 1;
  for (;;) {
    const response = await fetchSmartCollections({ page, pageSize: PAGE_SIZE });
    items.push(...response.data);
    if (page >= response.pagination.totalPages) {
      return items;
    }
    page += 1;
  }
}

/**
 * Saved Smart Collection summaries for the sidebar and editor.
 *
 * One list request (plus one per additional page) supplies every sidebar
 * `matchCount`; the sidebar never issues a request per Collection.
 */
export function SmartCollectionsProvider({ children }: { children: ReactNode }): ReactElement {
  const [collections, setCollections] = useState<SmartCollectionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const id = request.current + 1;
    request.current = id;
    setLoading(true);
    try {
      const next = await loadAllCollections();
      if (request.current === id) {
        setCollections(next);
        setError(null);
      }
    } catch (loadError) {
      if (request.current === id) {
        setError((loadError as Error).message);
      }
    } finally {
      if (request.current === id) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = useCallback((id: string) => {
    setCollections((current) => current.filter((collection) => collection.id !== id));
  }, []);

  const value = useMemo<SmartCollectionsContextValue>(
    () => ({ collections, loading, error, reload, remove }),
    [collections, error, loading, reload, remove],
  );

  return (
    <SmartCollectionsContext.Provider value={value}>{children}</SmartCollectionsContext.Provider>
  );
}

export function useSmartCollections(): SmartCollectionsContextValue {
  const value = useContext(SmartCollectionsContext);
  if (value === null) {
    throw new Error("useSmartCollections must be used inside SmartCollectionsProvider");
  }
  return value;
}
