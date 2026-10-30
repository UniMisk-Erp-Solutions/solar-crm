import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StatusBadge } from '@/components/domain/status';
import { Money } from '@/components/domain/values';
import { Card, CardBody, CardHeader } from '@/components/ui/surface';
import type { QuoteDetail } from './types';

/** Every version of this quotation, the first offer included, so a restart after a rejection or a cancelled deal can be compared with what was offered before. */
export function OfferHistoryCard({ quote }: { quote: QuoteDetail }) {
  const { t } = useTranslation();
  const versions = [...quote.versions].sort((a, b) => a.version - b.version);
  if (versions.length < 2) return null;
  return (
    <Card>
      <CardHeader title={t('quote.history.title', 'Earlier offers')} description={t('quote.history.sub', 'Every version of this quotation, starting with the first offer')} />
      <CardBody>
        <ul className="divide-y divide-border">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <span className="w-28 font-semibold">{v.version === 1 ? t('quote.history.first', 'First offer') : `${t('quote.version', 'Version')} ${v.version}`}</span>
              <StatusBadge kind="quote_status" value={v.status} />
              <span className="tabular ml-auto"><Money value={v.total} /></span>
              {v.id === quote.id ? <span className="text-muted">{t('quote.history.current', 'You are here')}</span> : <Link className="font-semibold text-primary-text underline" to={`/quotes/${v.id}`}>{t('quote.history.open', 'Open')}</Link>}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
