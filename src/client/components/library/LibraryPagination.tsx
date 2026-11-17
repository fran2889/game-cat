import { Button, Group, Text } from "@mantine/core";
import { formatRange } from "../../browse.ts";

export interface LibraryPaginationProps {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  onPageChange(page: number): void;
}

/** Library-only Mantine pagination controls. */
export function LibraryPagination({
  page,
  pageSize,
  totalItems,
  totalPages,
  onPageChange,
}: LibraryPaginationProps) {
  return (
    <Group component="nav" className="pagination" aria-label="Pagination" gap="sm" justify="center">
      <Button
        size="compact-sm"
        variant="default"
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page <= 1}
      >
        Previous
      </Button>
      <Text component="span" aria-live="polite">
        Page {page} of {totalPages}
      </Text>
      <Text component="span" className="pagination-range">
        {formatRange(page, pageSize, totalItems)}
      </Text>
      <Button
        size="compact-sm"
        variant="default"
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
      >
        Next
      </Button>
    </Group>
  );
}
