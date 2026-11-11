# static html page
tags: smoke

- goto /html
- waitFor h1
- expect text "Herman Melville"

```js evaluate as headings
return document.querySelectorAll('h1').length;
```

```js
expect(vars.headings === 1, 'expected exactly one h1');
```
