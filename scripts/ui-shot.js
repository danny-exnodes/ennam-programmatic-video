// Screenshot the editor UI (dev check). usage: node scripts/ui-shot.js "#p=<id>" [jsToEval] [out.png]
import { chromium } from 'playwright-core';
import { getBrowser } from '../server/render.js';

const [hash = '', js, out = 'ui.png'] = process.argv.slice(2);
const b = await getBrowser();
const pg = await b.newPage({ viewport: { width: 1845, height: 990 } });
const errs = [];
pg.on('pageerror', (e) => errs.push(e.message));
pg.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await pg.goto(`http://127.0.0.1:${process.env.PORT || 5173}/${hash}`);
await pg.waitForTimeout(2500);
if (js) await pg.evaluate(js);
await pg.waitForTimeout(1500);
await pg.screenshot({ path: out });
console.log(errs.join('\n'));
await b.close();
void chromium;
