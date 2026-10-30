import { ModulePage } from '@/components/layout/ModulePage';
import VisitsTab from './VisitsTab';
import OpportunitiesTab from './OpportunitiesTab';

/** Site & Opportunity: the site visit workspace (steps 14–18) and the opportunity list (steps 19–20). */
export default function SiteModule() {
  return (
    <ModulePage module="site">
      {(section) => (section === 'opportunities' ? <OpportunitiesTab /> : <VisitsTab />)}
    </ModulePage>
  );
}
