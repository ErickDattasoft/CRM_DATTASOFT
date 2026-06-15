const fs = require('fs');
const file = 'c:/Users/ERICK/Downloads/AGENDA CRM/agenda-clientes/src/pages/index.astro';
let content = fs.readFileSync(file, 'utf8');
const newScriptCode = fs.readFileSync('c:/Users/ERICK/Downloads/AGENDA CRM/agenda-clientes/new_script.js', 'utf8');

const replacedContent = content.replace(/<script id=\"crm-frontend-logic\">[\s\S]*?<\/script>/, `<script type="module" id="crm-frontend-logic">\n${newScriptCode}\n</script>`);
fs.writeFileSync(file, replacedContent);
console.log('File successfully updated!');
