"use client";

import { Pagination } from "@/components/pagination/pagination";
import type { PageSize } from "@/lib/utils/pagination";

interface ActivityPaginationProps {
  page: number;
  pageSize: PageSize;
  totalCount: number;
  totalPages: number;
  entity?: string;
  action?: string;
  actor?: string;
  student?: string;
  fellowship?: string;
  from?: string;
  to?: string;
}

/** Client boundary for Pagination's URL-producing handlers; navigation remains server-backed. */
export function ActivityPagination({ page, pageSize, totalCount, totalPages, entity, action, actor, student, fellowship, from, to }: ActivityPaginationProps) {
  function href(nextPage: number, nextSize: PageSize = pageSize) {
    const query = new URLSearchParams();
    if (entity) query.set("entity", entity);
    if (action) query.set("action", action);
    if (actor) query.set("actor", actor);
    if (student) query.set("student", student);
    if (fellowship) query.set("fellowship", fellowship);
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    query.set("page", String(nextPage));
    query.set("pageSize", String(nextSize));
    return `/activity?${query.toString()}`;
  }

  return <Pagination
    page={page}
    pageSize={pageSize}
    totalCount={totalCount}
    totalPages={totalPages}
    getPageHref={(nextPage) => href(nextPage)}
    getPageSizeHref={(nextSize) => href(1, nextSize as PageSize)}
  />;
}
