import React, { createContext, useContext, useState, useEffect } from 'react';
import { translations } from '../i18n/translations';

type Language = 'en' | 'id';

type TranslationShape = typeof translations['en'];
type TranslateFunction = (key: string, fallback?: string) => string;
export type TFunction = TranslateFunction & TranslationShape;

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: TFunction;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const warnedMissingKeys = new Set<string>();

function resolveNestedKey(root: unknown, key: string): string | undefined {
  const keys = key.split('.');
  let value: unknown = root;
  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = (value as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return typeof value === 'string' ? value : undefined;
}

function humanizeKey(key: string): string {
  const leaf = key.split('.').pop() || key;
  return leaf
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>('en');

  useEffect(() => {
    const savedLang = localStorage.getItem('language') as Language;
    if (savedLang && (savedLang === 'en' || savedLang === 'id')) {
      setLanguageState(savedLang);
    }
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('language', lang);
  };

  const translateFunction = (key: string, fallback?: string): string => {
    const localized = resolveNestedKey(translations[language], key);
    if (localized !== undefined) {
      return localized;
    }

    if (import.meta.env?.DEV) {
      const warnId = `${language}:${key}`;
      if (!warnedMissingKeys.has(warnId)) {
        warnedMissingKeys.add(warnId);
        console.warn(`[i18n] Missing translation key "${key}" for language "${language}"`);
      }
    }

    const englishFallback = language !== 'en' ? resolveNestedKey(translations.en, key) : undefined;
    if (englishFallback !== undefined) {
      return englishFallback;
    }

    return fallback || humanizeKey(key);
  };

  const t = Object.assign(translateFunction, translations[language]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}
