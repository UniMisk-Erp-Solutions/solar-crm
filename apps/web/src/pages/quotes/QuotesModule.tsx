import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModulePage } from '@/components/layout/ModulePage';
import { Button } from '@/components/ui/button';
import ApprovalsTab from './ApprovalsTab';
import NewQuoteModal from './NewQuoteModal';
import QuotationsTab from './QuotationsTab';

/** Quotation: the quotation list (steps 21–22, 24–27) and the approval matrix inbox (step 23). */
export default function QuotesModule() {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <ModulePage module="quotes"
        actions={(section) => (section === 'quotations' ? <Button leftIcon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setCreating(true)}>{t('quotes.new', 'New quotation')}</Button> : null)}>
        {(section) => (section === 'approvals' ? <ApprovalsTab /> : <QuotationsTab />)}
      </ModulePage>
      <NewQuoteModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
