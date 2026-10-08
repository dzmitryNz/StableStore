#!/usr/bin/env node
// Builds the data files for a fresh spareparts instance from the Grocy CSVs of StableStore.
// Usage: node integration/spareparts/seed.mjs --people 2.6 --months 3 --out ~/food-data [--force] [--src DIR]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Must match COLUMNS in spareparts/server.js.
export const COLUMNS = {
  items: ['id', 'name', 'kind', 'unit', 'category', 'min_qty', 'price', 'note'],
  locations: ['id', 'name', 'parent', 'note'],
  tasks: ['id', 'name', 'parent', 'status', 'note'],
  categories: ['name'],
  moves: ['date', 'type', 'item', 'qty', 'unit_price', 'brand', 'location', 'to_location', 'task', 'note', 'ref', 'best_before'],
};

// Grocy quantity unit -> spareparts unit.
const UNITS = { kg: 'kg', L: 'l', piece: 'pcs', g: 'g', ml: 'ml', package: 'pack', can: 'can', bottle: 'bottle' };

const LATIN = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

// 'Рис белый' -> 'RIS-BELYY'
export function slug(name) {
  const latin = [...name.toLowerCase()].map((c) => LATIN[c] ?? c).join('');
  return latin.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase();
}

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.some((v) => v !== ''));
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.replace(/^﻿/, ''), r[i] ?? ''])));
}

const cell = (v) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const toCSV = (rows, columns) => [columns, ...rows.map((r) => columns.map((c) => String(r[c] ?? '')))].map((r) => r.map(cell).join(',')).join('\n') + '\n';

export async function loadSource(dir) {
  const read = async (file) => parseCSV(await readFile(join(dir, file), 'utf8'));
  const [products, locations, groups, units] = await Promise.all(
    ['products-essential.csv', 'locations.csv', 'product-groups.csv', 'quantities.csv'].map(read));
  return { products, locations, groups, units };
}

// Norms in the source are for 1 adult for 1 month; min_qty = norm x people x months.
export function buildSeed({ products, locations, groups, units }, { people, months }) {
  if (!(people > 0)) throw new Error('people must be a positive number');
  if (!(months > 0)) throw new Error('months must be a positive number');
  const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
  const [locs, grps, qus] = [byId(locations), byId(groups), byId(units)];
  const seen = new Set();
  const items = products.map((p) => {
    const ref = (map, col) => {
      const hit = map.get(p[col]);
      if (!hit) throw new Error(`${p.name}: unknown ${col} ${p[col]}`);
      return hit;
    };
    ref(locs, 'location_id');
    const id = slug(p.name);
    if (seen.has(id)) throw new Error(`duplicate id ${id} (${p.name})`);
    seen.add(id);
    const unit = ref(qus, 'qu_id_stock').name;
    return {
      id, name: p.name, kind: 'consumable', unit: UNITS[unit] ?? unit, category: ref(grps, 'product_group_id').name,
      min_qty: String(Number((Number(p.min_stock_amount) * people * months).toFixed(2))), price: '', note: p.description ?? '',
    };
  });
  return {
    items,
    categories: groups.map((g) => ({ name: g.name })),
    locations: locations.map((l) => ({ id: slug(l.name), name: l.name, parent: '', note: l.description ?? '' })),
    tasks: [],
    moves: [],
  };
}

// Writes all five files; refuses (before writing anything) when one of them already has data rows.
export async function writeSeed(dir, seed, { force = false } = {}) {
  await mkdir(dir, { recursive: true });
  const tables = Object.keys(COLUMNS);
  if (!force) {
    for (const table of tables) {
      const text = await readFile(join(dir, `${table}.csv`), 'utf8').catch(() => '');
      if (text.split(/\r?\n/).slice(1).some((line) => line.trim() !== '')) {
        throw new Error(`${table}.csv already has data in ${dir}; use --force to overwrite`);
      }
    }
  }
  for (const table of tables) await writeFile(join(dir, `${table}.csv`), toCSV(seed[table] ?? [], COLUMNS[table]));
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const { values } = parseArgs({
    options: {
      people: { type: 'string', default: '1' },
      months: { type: 'string', default: '1' },
      out: { type: 'string' },
      src: { type: 'string', default: join(here, '..', 'grocy') },
      force: { type: 'boolean', default: false },
    },
  });
  if (!values.out) throw new Error('--out DIR is required');
  const seed = buildSeed(await loadSource(values.src), { people: Number(values.people), months: Number(values.months) });
  await writeSeed(resolve(values.out), seed, { force: values.force });
  console.log(`${seed.items.length} items, ${seed.categories.length} categories, ${seed.locations.length} locations -> ${resolve(values.out)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
