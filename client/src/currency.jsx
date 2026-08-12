/**
 * Currency context
 *
 * Loads the store's currency once (from /api/store-info) and exposes a
 * `format(amount)` helper so every price renders in the merchant's real
 * currency (e.g. ₹ for INR) instead of a hard-coded "$".
 */
import React, { createContext, useContext, useEffect, useState } from 'react';
import { getStoreInfo } from './api';

const CurrencyContext = createContext({
  currency: 'USD',
  symbol: '$',
  format: (n) => `$${Number(n || 0).toFixed(2)}`,
});

export function CurrencyProvider({ children }) {
  const [info, setInfo] = useState({ currency: 'USD', symbol: '$', decimal_places: 2 });

  useEffect(() => {
    getStoreInfo()
      .then((data) =>
        setInfo({
          currency: data.currency || 'USD',
          symbol: data.currency_symbol || '$',
          decimal_places: data.decimal_places ?? 2,
        })
      )
      .catch(() => {
        /* keep the USD fallback if the lookup fails */
      });
  }, []);

  // Prefer Intl formatting from the ISO code (gives the correct symbol +
  // thousands/decimal separators). Fall back to a plain symbol prefix.
  const format = (amount) => {
    const n = Number(amount) || 0;
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: info.currency,
        minimumFractionDigits: info.decimal_places,
        maximumFractionDigits: info.decimal_places,
      }).format(n);
    } catch {
      return `${info.symbol}${n.toFixed(info.decimal_places)}`;
    }
  };

  return (
    <CurrencyContext.Provider value={{ ...info, format }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export const useCurrency = () => useContext(CurrencyContext);
