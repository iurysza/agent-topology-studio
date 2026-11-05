// One flag for "this page holds edits not on disk", with what holds them for the leaving dialog's text.
// The editor and a role's page set it; the shell (main.tsx) reads it before an in-app route change and before the tab closes.
let unsaved: string | null = null;

/** `what` names the page's subject, e.g. "the workflow build". */
export const setUnsaved = (on: boolean, what = "this page"): void => { unsaved = on ? what : null; };
export const isUnsaved = (): boolean => unsaved !== null;
export const unsavedWhat = (): string => unsaved ?? "this page";
