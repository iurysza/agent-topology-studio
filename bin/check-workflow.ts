import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkWorkflowCode } from '../server/check.ts';
import { messageOf } from '../server/narrow.ts';
try {
  const file = process.argv[2]; if (!file) throw new Error('Usage: npm run check-workflow -- <file>');
  const result = checkWorkflowCode(await readFile(file, 'utf8'), { fileName: path.basename(file) });
  if (result.errors.length) { result.errors.forEach(e => console.error(e)); process.exitCode = 1; }
  else {
    // checkWorkflowCode sets meta whenever errors is empty. The old code read meta.name here and threw this TypeError on null.
    if (result.meta === null) throw new TypeError("Cannot read properties of null (reading 'name')");
    console.log(`ok ${result.meta.name}`); result.warnings.forEach(w => console.warn(w)); }
} catch (e) { console.error(messageOf(e)); process.exitCode = 1; }
