import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
const ALL_COLLECTIONS_KEY = ["smart-collections", "all"] as const;

async function loadAllCollections(signal?: AbortSignal): Promise<SmartCollectionListItem[]> {
  const items: SmartCollectionListItem[] = [];
  let page = 1;
  for (;;) {
    const response = await fetchSmartCollections({ page, pageSize: PAGE_SIZE }, signal);
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
 * One query (plus one page request per additional page) supplies every sidebar
 * `matchCount`; the sidebar never issues a request per Collection.
 */
export function SmartCollectionsProvider({ children }: { children: ReactNode }): ReactElement {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ALL_COLLECTIONS_KEY,
    queryFn: ({ signal }) => loadAllCollections(signal),
  });

  const reload = useCallback(async (): Promise<void> => {
    await query.refetch();
  }, [query.refetch]);

  const remove = useCallback(
    (id: string) => {
      queryClient.setQueryData<SmartCollectionListItem[]>(ALL_COLLECTIONS_KEY, (current) =>
        current?.filter((collection) => collection.id !== id),
      );
    },
    [queryClient],
  );

  const collections = query.data ?? [];
  const error = query.error === null ? null : (query.error as Error).message;

  const value = useMemo<SmartCollectionsContextValue>(
    () => ({ collections, loading: query.isPending, error, reload, remove }),
    [collections, error, query.isPending, reload, remove],
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
