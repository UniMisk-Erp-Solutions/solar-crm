import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ModulePage } from '@/components/layout/ModulePage';
import { FollowupsTab } from './FollowupsTab';
import { InquiriesTab } from './InquiriesTab';

export default function LeadsModule() {
  const { t } = useTranslation();
  const [newOpen, setNewOpen] = useState(false);
  return (
    <ModulePage
      module="leads"
      actions={(section) => section === 'inquiries' ? <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setNewOpen(true)}>{t('leads.new.button', 'New inquiry')}</Button> : null}
    >
      {(section) => section === 'followups' ? <FollowupsTab /> : <InquiriesTab newOpen={newOpen} setNewOpen={setNewOpen} />}
    </ModulePage>
  );
}
