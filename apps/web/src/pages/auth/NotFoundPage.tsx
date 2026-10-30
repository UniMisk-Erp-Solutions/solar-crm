import { SearchX } from 'lucide-react';
import { LinkButton } from '@/components/ui/button';
import { EmptyState, Page } from '@/components/ui/surface';

export default function NotFoundPage() {
  return (
    <Page>
      <EmptyState icon={<SearchX className="h-6 w-6" />} title="We could not find that page" description="The link may be old." action={<LinkButton to="/">Back to the dashboard</LinkButton>} />
    </Page>
  );
}
