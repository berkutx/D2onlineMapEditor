/**
 * Entry point: choose the interface language and load its dictionary FIRST, then import
 * the application. The order matters — modules call tr() at their top level (tool labels,
 * option lists), and those calls must already see the dictionary.
 */
import { initI18n } from "./i18n";

void initI18n().then(() => import("./bootstrap"));
