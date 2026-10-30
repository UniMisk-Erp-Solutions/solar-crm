import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from '@/locales/en.json';
import gu from '@/locales/gu.json';
import hi from '@/locales/hi.json';

export const LANGUAGES = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { code: 'gu', label: 'Gujarati', native: 'ગુજરાતી' },
] as const;
export type LangCode = (typeof LANGUAGES)[number]['code'];

/**
 * Convention used everywhere in the UI: a translate call with a dotted key and the English text as its second argument
 * The English text doubles as the fallback, so the app is always readable; `npm run i18n:extract` collects every
 * key into locales/en.json and the Hindi / Gujarati files carry the translations.
 */
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, hi: { translation: hi }, gu: { translation: gu } },
    fallbackLng: 'en',
    supportedLngs: ['en', 'hi', 'gu'],
    interpolation: { escapeValue: false },
    keySeparator: false, // keys are flat dotted strings
    detection: { order: ['localStorage', 'navigator'], lookupLocalStorage: 'fs-lang', caches: ['localStorage'] },
    returnNull: false,
  });

document.documentElement.lang = i18n.language.slice(0, 2);
i18n.on('languageChanged', (l) => { document.documentElement.lang = l.slice(0, 2); });

export default i18n;
