import { ListPageLoading } from "@/components/ui/list-page-loading";

export default function ApplicationsLoading() {
  return <ListPageLoading stats={4} headerBadges={3} rows={6} toolbarFilters={2} />;
}
