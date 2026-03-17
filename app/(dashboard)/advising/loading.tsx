import { ListPageLoading } from "@/components/ui/list-page-loading";

export default function AdvisingLoading() {
  return <ListPageLoading stats={4} headerBadges={3} pills={3} showBanner rows={6} toolbarFilters={2} />;
}
