// Pick a genuinely new pump coin for the on-demand check: newest GeckoTerminal pool with some
// liquidity whose mint FlagKan has not judged yet. Writes fresh.json {mint, name}.
import fs from 'node:fs';
const r = await fetch('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1', { headers: { Accept: 'application/json' } });
const d = await r.json();
for (const p of d.data) {
  const a = p.attributes; const mint = p.relationships.base_token.data.id.replace(/^solana_/, '');
  const name = a.name.split(' / ')[0];
  if (!mint.endsWith('pump') || !(Number(a.reserve_in_usd) > 1500) || name.length > 14 || !/^[\x20-\x7e]+$/.test(name)) continue;
  const v = await (await fetch('https://flag.sornkan.com/api/verdict?mint=' + mint)).json();
  if (v.error) { fs.writeFileSync(new URL('./fresh.json', import.meta.url), JSON.stringify({ mint, name, pool_created_at: a.pool_created_at })); console.log('fresh', name, mint, a.pool_created_at, a.reserve_in_usd); process.exit(0); }
}
console.log('no fresh coin found'); process.exit(1);
