# httpbin HTML page
Opens a static public page and checks its content. Markdown scenario.

- goto https://httpbin.org/html
- waitFor h1
- extract h1 as title
- expect text "Herman Melville"
- expect visible h1
- screenshot httpbin-html.png
