const SITE = 'https://www.oggiamensa.it/';
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const RESET_HOUR = 14;   // deve restare allineato a RESET_HOUR in index.html

if(!PROJECT_ID) throw new Error('Manca FIREBASE_PROJECT_ID');

function romeParts(date = new Date()){
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)])
  );
  return p; // {year, month, day, hour, minute}
}

/* Il pranzo a cui si riferisce il turno di voto in corso:
   prima delle 14 è quello di oggi, dopo le 14 quello di domani. */
function targetDate(){
  const p = romeParts();
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if(p.hour >= RESET_HOUR) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/* Stessa formula usata dal sito: settimana dell'anno, poi rotazione su 4. */
function weekNumberFor(d){
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const woy = Math.ceil(((d - jan1) / 864e5 + jan1.getUTCDay() + 1) / 7);
  return ((woy - 36) % 4 + 4) % 4 + 1;   // il +4 evita il modulo negativo di JS
}

/* ---------- parser sicuro per l'oggetto del menù ---------- */
function parseLiteral(text, start){
  let i = start;
  const ws = () => { while(i < text.length && /\s/.test(text[i])) i++; };

  function parseString(){
    const q = text[i++]; let out = '';
    while(i < text.length){
      const c = text[i];
      if(c === '\\'){
        const n = text[i+1];
        if(n === 'n') out += '\n';
        else if(n === 't') out += '\t';
        else if(n === 'u'){ out += String.fromCharCode(parseInt(text.substr(i+2,4),16)); i += 4; }
        else out += n;
        i += 2; continue;
      }
      if(c === q){ i++; return out; }
      out += c; i++;
    }
    throw new Error('stringa non chiusa');
  }

  function parseObject(){
    if(text[i] !== '{') throw new Error('atteso { a ' + i);
    i++; const obj = {}; ws();
    if(text[i] === '}'){ i++; return obj; }
    for(;;){
      ws();
      let key;
      if(text[i] === '"' || text[i] === "'") key = parseString();
      else {
        const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
        if(!m) throw new Error('chiave non valida a ' + i);
        key = m[0]; i += key.length;
      }
      ws();
      if(text[i] !== ':') throw new Error('atteso : a ' + i);
      i++; ws();
      if(text[i] === '{') obj[key] = parseObject();
      else if(text[i] === '"' || text[i] === "'") obj[key] = parseString();
      else throw new Error('valore non supportato a ' + i);
      ws();
      if(text[i] === ','){ i++; continue; }
      if(text[i] === '}'){ i++; return obj; }
      throw new Error('atteso , o } a ' + i);
    }
  }
  return parseObject();
}

/* ---------- download ---------- */
const UA = 'DovePranziamo/1.0 (app interna aziendale)';

async function getText(url){
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if(!res.ok) throw new Error(`${url} ha risposto ${res.status}`);
  return res.text();
}

async function findMenuBundle(){
  const html = await getText(SITE);
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map(m => new URL(m[1], SITE).href);
  if(srcs.length === 0) throw new Error('Nessuno script trovato nella pagina');

  for(const url of srcs){
    const js = await getText(url);
    if(js.includes('{week1:')) return { url, js };
  }
  throw new Error('Nessun bundle contiene il menù: la struttura del sito è cambiata');
}

/* ---------- estrazione ---------- */
const splitDishes = (s) => String(s || '')
  .split(/;\s*/)
  .map(x => x.replace(/🌱/g, '').replace(/\s+/g, ' ').trim())
  .filter(Boolean);

function extract(js, date){
  const itIdx = js.indexOf('{week1:');
  const menus = parseLiteral(js, itIdx);

  // slot di correzione manuale del sito: se compilato, vince su tutto
  const ovIdx = js.indexOf('{Today:');
  let override = null;
  if(ovIdx > -1){
    const o = parseLiteral(js, ovIdx).Today;
    if(o && Object.values(o).some(v => v !== '')) override = o;
  }

  const day = WEEKDAYS[date.getUTCDay()];
  const week = weekNumberFor(date);
  const raw = override || (menus['week' + week] || menus.week4)[day] || {};

  return {
    day, week,
    weekend: Boolean(raw.piattounico),
    primo:       splitDishes(raw.primo),
    secondo:     splitDishes(raw.secondo),
    contorni:    splitDishes(raw.contorni),
    rosticceria: splitDishes(raw.rosticceria),
    override: Boolean(override)
  };
}

/* ---------- scrittura su Firestore ---------- */
async function writeToFirestore(date, m){
  const iso = date.toISOString().slice(0, 10);
  const arr = (list) => ({ arrayValue: { values: list.map(v => ({ stringValue: v })) } });

  const fields = {
    date:        { stringValue: iso },
    source:      { stringValue: 'auto' },
    dayName:     { stringValue: m.day },
    weekNumber:  { integerValue: String(m.week) },
    weekend:     { booleanValue: m.weekend },
    primo:       arr(m.primo),
    secondo:     arr(m.secondo),
    contorni:    arr(m.contorni),
    rosticceria: arr(m.rosticceria),
    updatedAt:   { integerValue: String(Date.now()) }
  };

  const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${f}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/lunch/menu?${mask}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if(!res.ok) throw new Error(`Firestore ha risposto ${res.status}: ${await res.text()}`);
  return iso;
}

/* ---------- esecuzione ---------- */
const date = targetDate();
const { url, js } = await findMenuBundle();
console.log('Bundle:', url);

const menu = extract(js, date);
console.log(JSON.stringify(menu, null, 2));

const piatti = menu.primo.length + menu.secondo.length + menu.contorni.length + menu.rosticceria.length;
if(!menu.weekend && piatti === 0){
  throw new Error(`Nessun piatto estratto per ${menu.day} (week${menu.week}): controllare la struttura del bundle`);
}

const iso = await writeToFirestore(date, menu);
console.log(`Scritti ${piatti} piatti per ${menu.day} ${iso} (week${menu.week})${menu.override ? ' [correzione del sito]' : ''}.`);
