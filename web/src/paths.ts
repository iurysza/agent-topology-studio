// Where things live on disk: the project root from GET /api/project plus Pi's folders.

const join = (dir: string, rest: string) => (dir ? `${dir.replace(/\/+$/, "")}/${rest}` : rest);

/** A workflow's file: <dir>/.pi/workflows/<id>.js */
export const workflowPath = (dir: string, id: string) => join(dir, `.pi/workflows/${id}.js`);

/** A role's file: <dir>/.pi/agents/<name>.md */
export const rolePath = (dir: string, name: string) => join(dir, `.pi/agents/${name}.md`);

/** A path cut before its last slash, so the head can ellipsize and the file name always shows. */
export function splitPath(p: string): [head: string, tail: string] {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i), p.slice(i)];
}
