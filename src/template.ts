/** {{name}} substitution. An unknown variable is an error, never an empty string. */
export const interpolate = (text: string, vars: Record<string, string>): string =>
  text.replace(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`unknown variable {{${name}}}`);
    return vars[name]!;
  });
