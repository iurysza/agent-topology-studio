// Entry Pi loads (package.json "pi.extensions"). The factory lives in studio.ts so tests can inject fakes.
import { createStudioExtension } from './studio.ts';

export default createStudioExtension();
