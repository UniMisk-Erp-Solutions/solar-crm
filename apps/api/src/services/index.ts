import type { AppContext } from '../auth/context';
import { createClockService } from './clockService';
import { createComplianceService } from './complianceService';
import { createConsentService } from './consentService';
import type { Services } from './contracts';
import { createMessagingService } from './messagingService';
import { createNotifyService } from './notifyService';
import { createRuleService } from './ruleService';

export type ServiceOverrides = Partial<{ [K in keyof Services]: (ctx: AppContext) => Services[K] }>;

/** Builds the per-request service registry. Services are created lazily on first use and memoised. */
export function createServices(ctx: AppContext, overrides: ServiceOverrides = {}): Services {
  const memo: Partial<Record<keyof Services, unknown>> = {};
  const lazy = <K extends keyof Services>(key: K, make: (c: AppContext) => Services[K]): Services[K] => {
    if (!(key in memo)) memo[key] = (overrides[key] ?? make)(ctx);
    return memo[key] as Services[K];
  };
  return {
    get rules() { return lazy('rules', createRuleService); },
    get clocks() { return lazy('clocks', createClockService); },
    get notify() { return lazy('notify', createNotifyService); },
    get consent() { return lazy('consent', createConsentService); },
    get messaging() { return lazy('messaging', createMessagingService); },
    get compliance() { return lazy('compliance', createComplianceService); },
  };
}
