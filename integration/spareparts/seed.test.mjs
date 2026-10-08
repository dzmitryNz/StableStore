import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slug, buildSeed, writeSeed, loadSource, COLUMNS } from './seed.mjs';

const GROCY = join(dirname(fileURLToPath(import.meta.url)), '..', 'grocy');

const source = (products) => ({
  products,
  locations: [{ id: '1', name: 'Кладовка', description: 'Сухие продукты' }, { id: '4', name: 'Ведро №1', description: '' }],
  groups: [{ id: '1', name: 'Крупы и макароны' }, { id: '7', name: 'Масло и жиры' }],
  units: [{ id: '1', name: 'kg' }, { id: '2', name: 'L' }, { id: '3', name: 'piece' }, { id: '7', name: 'can' }],
});
const product = (name, extra = {}) =>
  ({ name, location_id: '4', qu_id_stock: '1', product_group_id: '1', min_stock_amount: '3', default_best_before_days: '1095', description: 'Основа рациона', ...extra });

test('slug transliterates to an upper-case ASCII id', () => {
  assert.equal(slug('Рис белый'), 'RIS-BELYY');
  assert.equal(slug('Ведро №1'), 'VEDRO-1');
  assert.equal(slug('Уксус 9%'), 'UKSUS-9');
  assert.equal(slug('Вода питьевая 5л'), 'VODA-PITEVAYA-5L');
  assert.equal(slug('Щи, ёж и чай'), 'SHCHI-YOZH-I-CHAY');
});

test('buildSeed: an item per product with id, unit, category and note; locations and categories', () => {
  const seed = buildSeed(source([product('Рис белый'), product('Масло подсолнечное', { location_id: '1', qu_id_stock: '2', product_group_id: '7' })]), { people: 1, months: 1 });
  assert.deepEqual(seed.items, [
    { id: 'RIS-BELYY', name: 'Рис белый', kind: 'consumable', unit: 'kg', category: 'Крупы и макароны', min_qty: '3', price: '', note: 'Основа рациона' },
    { id: 'MASLO-PODSOLNECHNOE', name: 'Масло подсолнечное', kind: 'consumable', unit: 'l', category: 'Масло и жиры', min_qty: '3', price: '', note: 'Основа рациона' },
  ]);
  assert.deepEqual(seed.categories, [{ name: 'Крупы и макароны' }, { name: 'Масло и жиры' }]);
  assert.deepEqual(seed.locations, [
    { id: 'KLADOVKA', name: 'Кладовка', parent: '', note: 'Сухие продукты' },
    { id: 'VEDRO-1', name: 'Ведро №1', parent: '', note: '' },
  ]);
});

test('buildSeed: min_qty = norm x people x months, rounded to 2 decimals', () => {
  const qty = (min_stock_amount, opts) => buildSeed(source([product('Рис', { min_stock_amount })]), opts).items[0].min_qty;
  assert.equal(qty('0.5', { people: 2.6, months: 1 }), '1.3');
  assert.equal(qty('3', { people: 2, months: 3 }), '18');
  assert.equal(qty('0.02', { people: 0.35, months: 1 }), '0.01');
});

test('buildSeed: people and months must be positive numbers', () => {
  assert.throws(() => buildSeed(source([product('Рис')]), { people: 0, months: 1 }), /people/);
  assert.throws(() => buildSeed(source([product('Рис')]), { people: 1, months: NaN }), /months/);
});

test('buildSeed: two products with the same id are refused', () => {
  assert.throws(() => buildSeed(source([product('Рис белый'), product('Рис  белый')]), { people: 1, months: 1 }), /duplicate id RIS-BELYY/);
});

test('buildSeed: an unknown location, group or unit names the product', () => {
  const bad = (extra) => () => buildSeed(source([product('Рис', extra)]), { people: 1, months: 1 });
  assert.throws(bad({ location_id: '99' }), /Рис: unknown location_id 99/);
  assert.throws(bad({ product_group_id: '99' }), /Рис: unknown product_group_id 99/);
  assert.throws(bad({ qu_id_stock: '99' }), /Рис: unknown qu_id_stock 99/);
});

test('writeSeed writes the five spareparts files with their headers; moves and tasks stay empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seed-'));
  try {
    await writeSeed(dir, buildSeed(source([product('Рис белый', { description: 'a, "b"' })]), { people: 1, months: 1 }));
    assert.equal(await readFile(join(dir, 'moves.csv'), 'utf8'), COLUMNS.moves.join(',') + '\n');
    assert.ok(COLUMNS.moves.includes('best_before'));
    assert.equal(await readFile(join(dir, 'tasks.csv'), 'utf8'), 'id,name,parent,status,note\n');
    assert.equal(await readFile(join(dir, 'items.csv'), 'utf8'),
      'id,name,kind,unit,category,min_qty,price,note\nRIS-BELYY,Рис белый,consumable,kg,Крупы и макароны,3,,"a, ""b"""\n');
    assert.equal(await readFile(join(dir, 'categories.csv'), 'utf8'), 'name\nКрупы и макароны\nМасло и жиры\n');
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('writeSeed refuses to overwrite a file with data rows unless forced; header-only files are fine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seed-'));
  const seed = buildSeed(source([product('Рис белый')]), { people: 1, months: 1 });
  try {
    await writeFile(join(dir, 'items.csv'), 'id,name,kind,unit,category,min_qty,price,note\n');
    await writeFile(join(dir, 'moves.csv'), COLUMNS.moves.join(',') + '\n2026-10-01,in,RIS-BELYY,1\n');
    await assert.rejects(writeSeed(dir, seed), /moves\.csv already has data/);
    assert.equal(await readFile(join(dir, 'items.csv'), 'utf8'), 'id,name,kind,unit,category,min_qty,price,note\n'); // nothing written
    await writeSeed(dir, seed, { force: true });
    assert.equal(await readFile(join(dir, 'moves.csv'), 'utf8'), COLUMNS.moves.join(',') + '\n');
    await writeFile(join(dir, 'moves.csv'), COLUMNS.moves.join(',') + '\n');
    await assert.rejects(writeSeed(dir, seed), /items\.csv already has data/); // the seed itself is data now
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('the Grocy CSVs in this repo give 50 items with unique ids and known categories', async () => {
  const seed = buildSeed(await loadSource(GROCY), { people: 1, months: 1 });
  assert.equal(seed.items.length, 50);
  assert.equal(new Set(seed.items.map((i) => i.id)).size, 50);
  const categories = new Set(seed.categories.map((c) => c.name));
  assert.ok(seed.items.every((i) => categories.has(i.category)));
  assert.equal(seed.locations.length, 10);
});
