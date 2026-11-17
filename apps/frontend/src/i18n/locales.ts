/**
 * The product's languages, imported rather than listed: next-intl, the
 * switcher, `<html lang>` and every backend call read the backend's one list,
 * so the language a person picks here is the one the model, the transcriber
 * and the live voice are given. A catalogue per code is this app's part
 * (`catalogue-parity.test.ts`).
 */
export { type Locale, locales } from "../../../backend/src/product/locales";
