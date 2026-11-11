/**
 * {{name}} substitution. Names may be dotted ({{item.id}}, {{env.API_USER}}).
 * `env.*` reads the environment map (process env plus the project's .env file);
 * everything else reads scenario variables. An unknown name is an error, never
 * an empty string. Non-string values are JSON-encoded.
 */
export type Vars = Record<string, unknown>;

const lookup = (root: unknown, parts: string[]): unknown => {
  let cur = root;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !(p in (cur as object))) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
};

export const interpolate = (text: string, vars: Vars, env: Record<string, string | undefined> = {}): string =>
  text.replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g, (_, name: string) => {
    const parts = name.split('.');
    const value = parts[0] === 'env' && parts.length > 1 ? env[parts.slice(1).join('.')] : lookup(vars, parts);
    if (value === undefined) throw new Error(`unknown variable {{${name}}}`);
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
