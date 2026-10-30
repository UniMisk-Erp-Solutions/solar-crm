import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Drawer } from '@/components/ui/overlay';
import { DateText, Kw } from '@/components/domain/values';
import { StatusBadge } from '@/components/domain/status';
import { Step } from './Step';
import type { SurveyRow, VisitLead } from './types';
import { VisitStep } from './steps/VisitStep';
import { RequirementStep } from './steps/RequirementStep';
import { RecommendStep } from './steps/RecommendStep';
import { NegotiationStep } from './steps/NegotiationStep';
import { QualifyDecision } from './steps/QualifyDecision';

type StepKey = '14' | '15' | '16' | '17';

/** The visit workspace: PDF steps 14 to 18 top to bottom as four cards (one open at a time), then the "Qualified project?" decision. */
export default function VisitWorkspace({ lead, survey, onClose }: { lead: VisitLead; survey: SurveyRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<StepKey | null>('14');
  const toggle = (k: StepKey) => setOpen((cur) => (cur === k ? null : k));
  return (
    <Drawer open onClose={onClose} width="xl" title={lead.name}
      description={<span className="flex flex-wrap items-center gap-3"><StatusBadge kind="lead_status" value={lead.status} /><Kw value={lead.capacity_kw} />{lead.city && <span>{lead.city}</span>}{survey?.scheduled_at && <span>{t('site.ws.visitOn', 'Visit')} <DateText value={survey.scheduled_at} /></span>}</span>}>
      <div className="space-y-4">
        <Step id="s14" no="14" title={t('site.ws.s14', 'Customer site visit')} open={open === '14'} onToggle={() => toggle('14')}
          summary={survey ? (survey.status === 'completed' ? t('site.ws.s14done', 'Visit completed') : t('site.ws.s14sched', 'Visit scheduled')) : t('site.ws.s14todo', 'Schedule the visit')}>
          <VisitStep lead={lead} surveyId={survey?.id ?? null} />
        </Step>
        <Step id="s15" no="15" title={t('site.ws.s15', 'Requirement capture form')} open={open === '15'} onToggle={() => toggle('15')} summary={t('site.ws.s15sum', 'Site, size, load type, timeline, specs, documents')}>
          <RequirementStep leadId={lead.id} />
        </Step>
        <Step id="s16" no="16" title={t('site.ws.s16', 'Product recommendation & brand USP')} open={open === '16'} onToggle={() => toggle('16')} summary={t('site.ws.s16sum', 'Recommended for this job')}>
          <RecommendStep lead={lead} />
        </Step>
        <Step id="s17" no="17–18" title={t('site.ws.s17', 'Technical discussion & rate negotiation')} open={open === '17'} onToggle={() => toggle('17')} summary={t('site.ws.s17sum', 'Notes and the rate per kW')}>
          <NegotiationStep leadId={lead.id} />
        </Step>
        <QualifyDecision lead={lead} onDone={onClose} />
      </div>
    </Drawer>
  );
}
