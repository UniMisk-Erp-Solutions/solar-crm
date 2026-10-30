import type { MessageChannel, MessagePurpose, TemplateCategory } from '../enums';
import type { MessageTemplate } from '../rows';
import { baseOf, refId, type SeedEnv } from './util';

type Lang = 'en' | 'hi' | 'gu';

interface TemplateSeed {
  key: string;
  channel: MessageChannel;
  category: TemplateCategory;
  purpose: MessagePurpose;
  language: Lang;
  subject?: string;
  body: string;
  /** WhatsApp approved-template name */
  wa?: string;
  /** SMS: DLT fields stay as placeholders until the templates are registered with the operator */
  dlt?: boolean;
}

const DLT_ID = 'TO-BE-REGISTERED';
const DLT_HEADER = 'FUTSLR';

/* ───────── consent notice v1 (shown on every intake form; purposes and recipients are filled per lead) ───────── */
const CONSENT: Record<Lang, string> = {
  en: 'Future Solar Pvt. Ltd. ({{company}}) will use your name, mobile number, e-mail and site details only to respond to your solar enquiry. By ticking the boxes below you allow us to contact you by {{channels}} for: {{purposes}}. '
    + 'Your details will be shared only with: {{recipients}}. You can withdraw your consent at any time — reply STOP on WhatsApp or SMS, tell us on a call, or use the link in any message. '
    + 'After you withdraw, we will not send you promotional messages for 90 days. Notice version: {{notice_version}}.',
  hi: 'फ्यूचर सोलर प्राइवेट लिमिटेड ({{company}}) आपकी सोलर पूछताछ का उत्तर देने के लिए ही आपके नाम, मोबाइल नंबर, ई-मेल और साइट के विवरण का उपयोग करेगी। नीचे दिए गए बॉक्स पर टिक करके आप हमें {{channels}} के माध्यम से इन उद्देश्यों के लिए संपर्क करने की अनुमति देते हैं: {{purposes}}। '
    + 'आपका विवरण केवल इनके साथ साझा किया जाएगा: {{recipients}}। आप किसी भी समय अपनी सहमति वापस ले सकते हैं — WhatsApp या SMS पर STOP लिखें, कॉल पर हमें बताएँ, या किसी भी संदेश में दिए गए लिंक का उपयोग करें। '
    + 'सहमति वापस लेने के बाद हम 90 दिनों तक आपको प्रचार संदेश नहीं भेजेंगे। सूचना संस्करण: {{notice_version}}।',
  gu: 'ફ્યુચર સોલર પ્રાઇવેટ લિમિટેડ ({{company}}) તમારી સોલર પૂછપરછનો જવાબ આપવા માટે જ તમારું નામ, મોબાઇલ નંબર, ઈ-મેઇલ અને સાઇટની વિગતોનો ઉપયોગ કરશે. નીચેના બૉક્સ પર ટિક કરીને તમે અમને {{channels}} દ્વારા આ હેતુઓ માટે સંપર્ક કરવાની પરવાનગી આપો છો: {{purposes}}. '
    + 'તમારી વિગતો ફક્ત આમની સાથે શેર કરવામાં આવશે: {{recipients}}. તમે કોઈપણ સમયે તમારી સંમતિ પાછી ખેંચી શકો છો — WhatsApp અથવા SMS પર STOP લખો, કૉલ પર અમને જણાવો, અથવા કોઈપણ સંદેશમાંની લિંકનો ઉપયોગ કરો. '
    + 'સંમતિ પાછી ખેંચ્યા પછી અમે 90 દિવસ સુધી તમને પ્રમોશનલ સંદેશા મોકલીશું નહીં. નોટિસ સંસ્કરણ: {{notice_version}}.',
};

const consent: TemplateSeed[] = (['en', 'hi', 'gu'] as const).map((language): TemplateSeed => ({
  key: 'consent_notice', channel: 'in_app', category: 'service', purpose: 'service', language, subject: 'Consent notice v1', body: CONSENT[language],
}));

/* ───────── WhatsApp: utility / service templates (marketing templates are deliberately not seeded) ───────── */
const ACK: Record<Lang, string> = {
  en: 'Namaste {{1}}, thank you for your solar enquiry with Future Solar. Your reference is {{2}}. {{3}} will contact you shortly. Reply STOP to opt out.',
  hi: 'नमस्ते {{1}}, फ्यूचर सोलर में सोलर पूछताछ के लिए धन्यवाद। आपका संदर्भ क्रमांक {{2}} है। {{3}} जल्द ही आपसे संपर्क करेंगे। बंद करने के लिए STOP लिखें।',
  gu: 'નમસ્તે {{1}}, ફ્યુચર સોલરમાં સોલર પૂછપરછ બદલ આભાર. તમારો સંદર્ભ ક્રમાંક {{2}} છે. {{3}} ટૂંક સમયમાં તમારો સંપર્ક કરશે. બંધ કરવા માટે STOP લખો.',
};
const OPTOUT: Record<Lang, string> = {
  en: 'You have been opted out of messages from Future Solar. We will not send you promotional messages for 90 days. Service messages about an existing order may still be sent.',
  hi: 'आपको फ्यूचर सोलर के संदेशों से हटा दिया गया है। हम 90 दिनों तक आपको प्रचार संदेश नहीं भेजेंगे। किसी मौजूदा ऑर्डर से जुड़े सेवा संदेश फिर भी भेजे जा सकते हैं।',
  gu: 'તમને ફ્યુચર સોલરના સંદેશાઓમાંથી દૂર કરવામાં આવ્યા છે. અમે 90 દિવસ સુધી તમને પ્રમોશનલ સંદેશા મોકલીશું નહીં. હાલના ઓર્ડર અંગેના સેવા સંદેશા હજી પણ મોકલવામાં આવી શકે છે.',
};

const whatsapp: TemplateSeed[] = [
  ...(['en', 'hi', 'gu'] as const).map((language): TemplateSeed => ({ key: 'wa.acknowledgement', channel: 'whatsapp', category: 'utility', purpose: 'transactional', language, body: ACK[language], wa: `fs_acknowledgement_v1_${language}` })),
  { key: 'wa.followup_reminder', channel: 'whatsapp', category: 'utility', purpose: 'service', language: 'en', body: 'Namaste {{1}}, this is a reminder from Future Solar about your solar enquiry {{2}}. {{3}} will call you on {{4}}. Reply STOP to opt out.', wa: 'fs_followup_reminder_v1_en' },
  { key: 'wa.quote_sent', channel: 'whatsapp', category: 'utility', purpose: 'transactional', language: 'en', body: 'Namaste {{1}}, your Future Solar quotation {{2}} for {{3}} kW is ready and valid until {{4}}. {{5}} will walk you through it. Reply STOP to opt out.', wa: 'fs_quote_sent_v1_en' },
  { key: 'wa.payment_reminder', channel: 'whatsapp', category: 'utility', purpose: 'transactional', language: 'en', body: 'Namaste {{1}}, a payment of ₹ {{2}} against proforma invoice {{3}} is due. Your order will be processed once it is received. Reply STOP to opt out.', wa: 'fs_payment_reminder_v1_en' },
  ...(['en', 'hi', 'gu'] as const).map((language): TemplateSeed => ({ key: 'wa.optout_confirmation', channel: 'whatsapp', category: 'service', purpose: 'service', language, body: OPTOUT[language], wa: `fs_optout_confirmation_v1_${language}` })),
];

/* ───────── SMS: DLT template id and header stay literal placeholders until registered ───────── */
const sms: TemplateSeed[] = [
  { key: 'sms.acknowledgement', channel: 'sms', category: 'utility', purpose: 'transactional', language: 'en', body: 'Dear {#var#}, thank you for your solar enquiry with Future Solar. Ref {#var#}. {#var#} will call you shortly. Reply STOP to opt out.', dlt: true },
  { key: 'sms.followup_reminder', channel: 'sms', category: 'utility', purpose: 'service', language: 'en', body: 'Dear {#var#}, Future Solar will call you on {#var#} about your enquiry {#var#}. Reply STOP to opt out.', dlt: true },
  { key: 'sms.quote_sent', channel: 'sms', category: 'utility', purpose: 'transactional', language: 'en', body: 'Dear {#var#}, your Future Solar quotation {#var#} is ready and valid until {#var#}. Reply STOP to opt out.', dlt: true },
  { key: 'sms.payment_reminder', channel: 'sms', category: 'utility', purpose: 'transactional', language: 'en', body: 'Dear {#var#}, Rs {#var#} against proforma invoice {#var#} is due. Please pay to proceed with your order. Reply STOP to opt out.', dlt: true },
  { key: 'sms.optout_confirmation', channel: 'sms', category: 'service', purpose: 'service', language: 'en', body: 'You are opted out of Future Solar promotional messages for 90 days. Service messages about existing orders may continue.', dlt: true },
  { key: 'sms.promo_subsidy_deadline', channel: 'sms', category: 'marketing', purpose: 'promotional', language: 'en', body: 'Dear {#var#}, subsidy claim and ALMM deadlines are near. Talk to Future Solar about your rooftop solar plan: {#var#}. Reply STOP to opt out.', dlt: true },
];

/* ───────── quote clauses (e-mail service templates, selected on the quote builder) ───────── */
const clause = (key: string, subject: string, body: string): TemplateSeed => ({ key, channel: 'email', category: 'service', purpose: 'service', language: 'en', subject, body });
const clauses: TemplateSeed[] = [
  clause('clause.duty_change', 'Change in customs duty', 'Prices are based on the customs duty rates in force on {{price_date}}. If basic customs duty, AIDC, anti-dumping duty or any other levy on modules, cells or inverters changes before dispatch, the price will be revised by the amount of the change and a revised quotation will be issued.'),
  clause('clause.gst_change', 'Change in GST', 'Prices are exclusive of GST. GST is charged at the rate in force at the time of supply, not on the order date. If the rate or the HSN classification changes before supply, the invoice will carry the rate then applicable.'),
  clause('clause.almm_change', 'Change in ALMM listing', 'Supply is of models listed on the ALMM on the date of this quotation. If a listed model or cell source is removed, suspended or becomes ineligible for this project before commissioning, Future Solar may substitute an eligible model of equal or higher rating, or revise this quotation, with your written approval.'),
  clause('clause.price_validity', 'Price validity', 'This quotation is valid until {{validity_date}}. It lapses earlier if a duty, GST rate, ALMM listing or exemption date that it depends on changes; a revised quotation will then be issued.'),
  clause('clause.payment_terms_default', 'Payment terms', '{{advance_pct}} % advance with the purchase order; the balance against dispatch documents before delivery. Subsidy (CFA) is credited by the Government to the customer\'s bank account and is not part of the amount payable to Future Solar.'),
];

/* ───────── internal reminders (in-app notifications) ───────── */
const internal = (key: string, subject: string, body: string): TemplateSeed => ({ key, channel: 'in_app', category: 'service', purpose: 'service', language: 'en', subject, body });
const internals: TemplateSeed[] = [
  internal('internal.lead_acceptance_due', 'Lead awaiting acceptance', 'Lead {{lead_name}} ({{segment}}, {{temperature}}) must be accepted by {{due_at}}. Accept or reject it to stop the clock.'),
  internal('internal.followup_overdue', 'Follow-up overdue', 'The follow-up with {{lead_name}} was due {{due_at}}. Log the contact and set the next follow-up date.'),
  internal('internal.quote_followup', 'Quote follow-up due', 'Quotation {{quote_no}} was sent {{days}} days ago. Follow up with the customer; escalation follows day 7.'),
  internal('internal.approval_pending', 'Approval waiting', '{{entity}} {{ref}} is waiting for your decision in the {{lane}} lane. SLA: {{due_at}}.'),
  internal('internal.legacy_claim_countdown', 'Legacy CFA claim deadline', '{{count}} legacy-cohort subsidy claim(s) must be received by {{deadline}} — {{days}} day(s) left. Open the daily work-list.'),
  internal('internal.bg_expiry', 'Bank guarantee expiring', 'The bank guarantee of {{dealer}} expires on {{date}} ({{days}} days). Ask for a renewal before the vendor registration lapses.'),
  internal('internal.sop_deadline', 'MNRE SOP deadline', 'Complaint {{complaint_ref}} against {{dealer}} is at the {{stage}} stage; the next step is due {{due_at}}.'),
];

export const TEMPLATE_SEEDS: readonly TemplateSeed[] = [...consent, ...whatsapp, ...sms, ...clauses, ...internals];

export function buildTemplates(env: SeedEnv): MessageTemplate[] {
  return TEMPLATE_SEEDS.map((t, i) => ({
    ...baseOf(env, refId('template', i + 1), 30 * 1440),
    key: t.key, channel: t.channel, category: t.category, purpose: t.purpose, language: t.language, subject: t.subject ?? null, body: t.body,
    dlt_template_id: t.dlt ? DLT_ID : null, dlt_header: t.dlt ? DLT_HEADER : null, whatsapp_template_name: t.wa ?? null, version: 1, active: true,
  }));
}
