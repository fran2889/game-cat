import type { Pagination } from "../../shared/types.ts";

/** The documented Pagination envelope shared by every paged Library read. */
export function pagination(page: number, pageSize: number, totalItems: number): Pagination {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
  };
}
