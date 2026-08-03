const fs = require('fs');
const path = require('path');

const source = path.join(
  path.dirname(require.resolve('ag-grid-community')),
  '..',
  'ag-grid-community.min.js'
);
const vendorDir = path.join(__dirname, '..', 'public', 'vendor');
const destination = path.join(vendorDir, 'ag-grid-community.min.js');

fs.mkdirSync(vendorDir, { recursive: true });
fs.copyFileSync(source, destination);
console.log(`Installed AG Grid browser bundle: ${path.relative(process.cwd(), destination)}`);
