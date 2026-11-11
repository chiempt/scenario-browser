# title check
tags: smoke, quick

- include ../shared/open-home.json
- expect js "document.title === 'Example Domain'"
