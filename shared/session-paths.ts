export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/\\]/g, '-').replace(/^[A-Za-z]:-/, '').replace(/^-+/, '');
}
