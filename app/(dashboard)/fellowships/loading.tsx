import { ListPageLoading } from "@/components/ui/list-page-loading";

export default function FellowshipsLoading() {
  return <ListPageLoading stats={4} headerBadges={4} pills={2} showBanner rows={6} toolbarFilters={1} />;
}
