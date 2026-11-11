// Node-side script: `page`, `vars`, `env`, `expect`, `context` are in scope.
const text = await page.innerText('body');
expect(text.includes(vars.needle), `page should mention "${vars.needle}"`);
vars.wordCount = text.split(/\s+/).length;
