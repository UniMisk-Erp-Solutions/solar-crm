import { ModulePage } from '@/components/layout/ModulePage';
import EscalationsTab from './EscalationsTab';
import KpisTab from './KpisTab';

export default function ControlModule() {
  return <ModulePage module="control">{(section) => (section === 'escalations' ? <EscalationsTab /> : <KpisTab />)}</ModulePage>;
}
